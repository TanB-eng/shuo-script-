// 世界状态：自身、玩家、金币、子弹、最近伤害事件的权威存储。
// 丢弃过期实体，只保留在有效时间窗内的状态。

import { PROTOCOL } from './config.js';

const ENTITY_MAX_AGE_MS = 5000; // pos 帧 20fps，5s 无更新视为过期
const COIN_MAX_AGE_MS = 30000; // 金币较持久，30s 无更新视为消失

export class WorldState {
  constructor() {
    this.self = null; // 自身实体快照
    this.entities = new Map(); // user_id -> entity
    this.coinDrops = new Map(); // id -> coin
    this.bullets = [];
    this.lastSnapshotAt = 0;
    this.lastPosAt = 0;
    this.hpEvents = []; // 最近伤害/恢复事件，用于确认攻击者
    this.tick = 0;
  }

  // 应用一次 WS 消息（snapshot 或 pos）。
  applyWsMessage(msg, now = Date.now()) {
    if (msg.tick) this.tick = msg.tick;
    if (msg.type === 'snapshot') {
      this.lastSnapshotAt = now;
      // 先更新 bullets，再 merge entities ——
      // _mergeEntities 触发 _trackHp 时会记录"此刻的子弹快照"用于识别攻击者，
      // 若顺序反了，掉血记录的是上一帧的旧子弹。
      if (Array.isArray(msg.bullets)) this.bullets = msg.bullets;
      if (Array.isArray(msg.entities)) this._mergeEntities(msg.entities, now);
      if (Array.isArray(msg.coin_drops)) this._mergeCoins(msg.coin_drops, now);
    } else if (msg.type === 'pos') {
      this.lastPosAt = now;
      if (Array.isArray(msg.bullets)) this.bullets = msg.bullets;
      if (Array.isArray(msg.entities)) this._mergeEntities(msg.entities, now);
    }
    this._prune(now);
  }

  setSelf(userId) {
    const id = Number(userId);
    if (this.self && Number(this.self.user_id) === id) return;
    this.self = this.entities.get(id) || { user_id: id };
  }

  _mergeEntities(list, now) {
    for (const e of list) {
      const id = Number(e.user_id);
      const prev = this.entities.get(id) || {};
      // 关键：pos 帧(20fps)只带 x/y/vx/vy/hp/life，不带 max_hp、stamina_* 等字段。
      // 若直接展开 {...prev, ...e}，pos 帧里"存在但为 undefined"的键会把 snapshot
      // 拿到的好值覆盖成 undefined（曾导致 max_hp 变 undefined、满血判断失效）。
      // 所以只合并真正有值的字段。
      const merged = { ...prev };
      for (const [k, v] of Object.entries(e)) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
      merged._updatedAt = now;
      this.entities.set(id, merged);
      if (this.self && id === Number(this.self.user_id)) {
        this._trackHp(merged, now);
        this.self = merged;
      }
    }
  }

  // snapshot 的 coin_drops 是全量权威数据：被捡走/消失的金币【必须从内存移除】，
  // 而不是只在 30 秒后靠 _prune 清理。否则金币消失后的 30 秒内，
  // bot 会一直"走向一个已不存在的金币"(表现为拾取完原地发呆)。
  _mergeCoins(list, now) {
    const next = new Map();
    for (const c of list) {
      const key = c.id !== undefined ? c.id : `${c.x},${c.y}`;
      next.set(key, { ...c, _updatedAt: now });
    }
    this.coinDrops = next;
  }

  // 记录掉血事件用于确认攻击者。注意 entity 是即将成为 this.self 的对象，
  // _prevHp 直接写在它上面，避免用展开式重建 self 导致字段丢失。
  _trackHp(entity, now) {
    const prevHp = this.self?._prevHp;
    if (prevHp !== undefined && entity.hp !== undefined && entity.hp < prevHp) {
      // 记录掉血瞬间的子弹快照 —— 用子弹 owner_user_id 精确识别"谁在打我"。
      this.hpEvents.push({
        at: now,
        hpLoss: prevHp - entity.hp,
        self: { x: entity.x, y: entity.y },
        bullets: this.bullets.slice(0, 100), // 快照此刻所有子弹，用于关联攻击者
      });
      if (this.hpEvents.length > 50) this.hpEvents.splice(0, this.hpEvents.length - 50);
    }
    entity._prevHp = entity.hp !== undefined ? entity.hp : prevHp;
  }

  // 从一次掉血事件里，找出"很可能正在打我"的玩家。
  // 判定：存在非自己发射的子弹，其位置在掉血位置附近(命中范围内)。
  // 返回该子弹的 owner_user_id；找不到返回 null。
  //
  // strict=true（反击用）：子弹确认不了就直接返回 null，绝不退化为"打最近的玩家"。
  // 退化逻辑会导致：攻击者的子弹一时对不上时，把旁边站着的 0 金币无辜玩家误当攻击者
  // 锁定并反击（用户实测：反击几下后去打周围 0 金币的人）。反击必须只打确认的攻击者。
  attackerFromHpEvent(ev, now = Date.now(), strict = false) {
    if (!ev || now - ev.at > 3000) return null;
    const myId = this.self?.user_id;
    for (const b of ev.bullets || []) {
      const owner = Number(b.owner_user_id);
      if (!owner || owner === myId) continue;          // 排除自己的子弹
      const bx = b.x ?? b.start_x, by = b.y ?? b.start_y;
      if (typeof bx !== 'number' || typeof by !== 'number') continue;
      // 子弹是否命中自身位置附近（90cm 命中半径，放宽到 200cm）
      if (Math.hypot(bx - ev.self.x, by - ev.self.y) < 200) {
        return owner;
      }
    }
    if (strict) return null; // 严格模式：确认不了就打不了，宁可原地戒备也不误伤无辜
    // 非严格模式（仅供参考）：退化为"掉血位置附近的最近玩家"
    const near = this.nearestTo(ev.self.x, ev.self.y);
    return near ? Number(near.user_id) : null;
  }

  clearAttackHistory() {
    this.hpEvents.length = 0;
  }

  // 离指定坐标最近的玩家（排除自身）。
  nearestTo(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.entities.values()) {
      if (p.user_id === this.self?.user_id) continue;
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return bestD < Infinity ? best : null;
  }

  _prune(now) {
    for (const [id, e] of this.entities) {
      if (now - (e._updatedAt || 0) > ENTITY_MAX_AGE_MS) this.entities.delete(id);
    }
    for (const [k, c] of this.coinDrops) {
      if (now - (c._updatedAt || 0) > COIN_MAX_AGE_MS) this.coinDrops.delete(k);
    }
  }

  selfJoined(now = Date.now()) {
    return !!this.self && this.self.user_id > 0 && (now - (this.self._updatedAt || 0)) < ENTITY_MAX_AGE_MS * 2;
  }

  // 可见玩家（排除自身），按更新时间取最近。
  visiblePlayers() {
    if (!this.self) return [];
    const myId = Number(this.self.user_id);
    return [...this.entities.values()].filter((e) => Number(e.user_id) !== myId && e.name !== undefined);
  }

  // 自身是否满血。max_hp 未知时一律视为"未满血"，宁可不动也不误判。
  isFullHp() {
    const e = this.self;
    if (!e) return false;
    if (typeof e.hp !== 'number') return false;
    if (typeof e.max_hp !== 'number' || e.max_hp <= 0) return false;
    return e.hp >= e.max_hp;
  }

  hpRatio() {
    if (!this.self || !this.self.max_hp) return 1;
    return (this.self.hp || 0) / this.self.max_hp;
  }

  // 1h 剩余体力(毫秒)。字段缺失时返回 null 表示未知。
  stamina1hMillis() {
    const v = this.self?.stamina_1h_remaining_milli;
    return typeof v === 'number' ? v : null;
  }

  // 体力是否够继续拾金(需高于保护线，以保住传送逃生能力)。
  // 未知时返回 false —— 宁可不动，也不冒失去逃生能力的风险。
  hasStaminaToScavenge(reserveMillis) {
    const v = this.stamina1hMillis();
    if (v === null) return false;
    return v > reserveMillis;
  }

  // 1h / 1d 传送体力是否足够。
  canTeleport(staminaNow) {
    const e = this.self;
    if (!e) return false;
    const need = PROTOCOL.teleportNeedMillis;
    const h1 = e.stamina_1h_remaining_milli ?? staminaNow?.h1 ?? PROTOCOL.staminaLimitsMillis.h1;
    const d1 = e.stamina_1d_remaining_milli ?? staminaNow?.d1 ?? PROTOCOL.staminaLimitsMillis.d1;
    return h1 >= need && d1 >= need;
  }

  reset() {
    this.self = null;
    this.entities.clear();
    this.coinDrops.clear();
    this.bullets = [];
    this.hpEvents = [];
    this.lastSnapshotAt = 0;
    this.lastPosAt = 0;
    this.tick = 0;
  }
}

// 简化的开放世界无碰撞移动：返回归一化方向向量。
export function directionTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { dx: 0, dy: 0 };
  return { dx: dx / len, dy: dy / len };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
