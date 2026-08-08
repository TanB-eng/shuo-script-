// 世界状态：自身、玩家、金币、子弹、最近伤害事件的权威存储。
// 丢弃过期实体，只保留在有效时间窗内的状态。

import { PROTOCOL } from './config.js';

const ENTITY_MAX_AGE_MS = 5000; // pos 帧 20fps，5s 无更新视为过期
const COIN_MAX_AGE_MS = 30000; // 金币较持久，30s 无更新视为消失
// "谁刚刚开过枪"的记忆时长：命中瞬间子弹即被移除，需靠这段记忆认出攻击者。
const SHOOTER_MEMORY_MS = 2000;
// 子弹射程(厘米)。与 bot-bridge 的 BULLET_RANGE_M(150m) 一致。
const BULLET_RANGE_CM = 150 * 100;

export class WorldState {
  constructor() {
    this.self = null; // 自身实体快照
    this.entities = new Map(); // user_id -> entity
    this.coinDrops = new Map(); // id -> coin
    this.bullets = [];
    this.lastSnapshotAt = 0;
    this.lastPosAt = 0;
    this.hpEvents = []; // 最近伤害/恢复事件，用于确认攻击者
    // 最近开过枪的人：Map<owner_user_id, 最后一次看到其子弹的时间>。
    // 用途：打中我的那颗子弹在命中瞬间就被服务器移除，掉血帧里往往已经没有它了，
    // 只靠"当前帧有子弹在我身边"根本认不出攻击者。记住"谁刚刚在开枪"才可靠。
    this.recentShooters = new Map();
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
      if (Array.isArray(msg.bullets)) { this.bullets = msg.bullets; this._trackShooters(now); }
      if (Array.isArray(msg.entities)) this._mergeEntities(msg.entities, now);
      if (Array.isArray(msg.coin_drops)) this._mergeCoins(msg.coin_drops, now);
    } else if (msg.type === 'pos') {
      this.lastPosAt = now;
      if (Array.isArray(msg.bullets)) { this.bullets = msg.bullets; this._trackShooters(now); }
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

  // 记录"谁在开枪"：每次收到带 bullets 的帧就把子弹主人记下来。
  _trackShooters(now) {
    const myId = Number(this.self?.user_id);
    for (const b of this.bullets) {
      const owner = Number(b?.owner_user_id);
      if (!owner || owner === myId) continue; // 自己的子弹不算
      this.recentShooters.set(owner, now);
    }
    // 清理过期记录，避免无界增长
    for (const [id, at] of this.recentShooters) {
      if (now - at > SHOOTER_MEMORY_MS) this.recentShooters.delete(id);
    }
  }

  // 从一次掉血事件里，找出"正在打我"的玩家，返回其 user_id；认不出返回 null。
  //
  // 判据（两个条件都要满足，既可靠又不会冤枉人）：
  //   ① 他【确实在开枪】—— 当前帧持有子弹，或最近 SHOOTER_MEMORY_MS 内开过枪
  //   ② 他【打得到我】—— 在子弹射程内
  // 多人同时开火时取最近的那个（最危险）。
  //
  // 为什么不用"子弹恰好落在我身边 2m 内"：打中我的那颗子弹在命中瞬间就被服务器
  // 从 bullets[] 移除，掉血帧里已经没有它了；且 pos 帧 20fps，子弹两帧间能跨好几米，
  // 采样点几乎不可能正好落在 2m 窗口内 —— 实测导致"挨打了却认不出是谁、不还击"。
  //
  // 为什么不退化成"打最近的玩家"：会把旁边站着的 0 金币无辜玩家当攻击者
  // (用户实测过的 bug)。"必须在开枪"这一条把无辜者彻底排除。
  attackerFromHpEvent(ev, now = Date.now(), strict = false) {
    if (!ev || now - ev.at > 3000) return null;
    const myId = Number(this.self?.user_id);
    const rangeCm = BULLET_RANGE_CM;

    // 候选集：当前帧持有子弹的人 + 最近开过枪的人
    const candidates = new Set();
    for (const b of ev.bullets || []) {
      const owner = Number(b?.owner_user_id);
      if (owner && owner !== myId) candidates.add(owner);
    }
    for (const [id, at] of this.recentShooters) {
      if (id !== myId && now - at <= SHOOTER_MEMORY_MS) candidates.add(id);
    }

    // 在候选里挑"离我最近且在射程内"的
    let best = null;
    let bestD = Infinity;
    for (const id of candidates) {
      const p = this.entities.get(id);
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (typeof p.hp === 'number' && p.hp <= 0) continue; // 已死的不打
      const d = Math.hypot(p.x - ev.self.x, p.y - ev.self.y);
      if (d > rangeCm) continue; // 打不到我的人不是嫌疑人
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best !== null) return best;

    if (strict) return null; // 认不出就不打，绝不误伤无辜
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

  // 1h 剩余体力(毫值)。字段缺失时返回 null 表示未知。
  stamina1hMillis() {
    const v = this.self?.stamina_1h_remaining_milli;
    return typeof v === 'number' ? v : null;
  }

  // 5s / 1d 剩余体力(毫值)，缺失返回 null。
  stamina5sMillis() {
    const v = this.self?.stamina_5s_remaining_milli;
    return typeof v === 'number' ? v : null;
  }

  stamina1dMillis() {
    const v = this.self?.stamina_1d_remaining_milli;
    return typeof v === 'number' ? v : null;
  }

  // 是否已无法移动：任一窗口耗尽，服务器就会拒绝移动指令
  // （官方规则：体力耗尽无法攻击和移动；移动 10m 耗 1 点）。
  // 移动一步至少要 1 点(=1000 毫值)，留一点余量判定。
  canMove() {
    const need = 1000;
    for (const v of [this.stamina5sMillis(), this.stamina1hMillis(), this.stamina1dMillis()]) {
      if (v !== null && v < need) return false;
    }
    return true;
  }

  // 用于日志的体力摘要（点数）
  staminaSummary() {
    const f = (v) => (v === null ? '?' : (v / 1000).toFixed(1));
    return `5s=${f(this.stamina5sMillis())} 1h=${f(this.stamina1hMillis())} 1d=${f(this.stamina1dMillis())}`;
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
    this.recentShooters.clear();
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
