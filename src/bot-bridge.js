// 桥接版主程序：Node 做决策大脑，浏览器(油猴脚本)持有真正的游戏连接。
//
// 为什么不用原来的 src/index.js：Cloudflare 按 TLS 指纹拦截 Node 原生 WS(持续 502)。
// 这里把传输层换成本机桥接，其余决策逻辑全部复用现有模块。
//
// 复用：state.js / strategy.js / cooldown.js / logger.js / config.js
// 替换：comms.js(直连 wss://) -> bridge.js(本机桥接)

import { CONFIG, ensureDataDir } from './config.js';
import { setLogLevel, log } from './logger.js';
import { BridgeServer } from './bridge.js';
import { WorldState, directionTo, distance } from './state.js';
import { chooseCoin, chooseAggroTarget, getPlayerGold, shouldEscape, chooseRandomEscapePosition, nearestPlayer, isUnderAttack, strafeDirection } from './strategy.js';
import { markOfflineCooldown, remainingCooldownMs } from './cooldown.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const State = Object.freeze({
  WAITING_BRIDGE: 'WAITING_BRIDGE',      // 等油猴脚本接入
  WAITING_FOR_FULL_HP: 'WAITING_FOR_FULL_HP',
  SCAVENGING: 'SCAVENGING',
  RETALIATING: 'RETALIATING',
  ESCAPING: 'ESCAPING',
  OFFLINE_COOLDOWN: 'OFFLINE_COOLDOWN',
});

// 与真实客户端一致的节流
const VEL_THROTTLE_MS = 100;
const SHOOT_THROTTLE_MS = 100;
const BULLET_RANGE_M = 150;
const SELF_SYNC_TIMEOUT_MS = 3000;

export class BridgeBot {
  constructor({ observeOnly = false } = {}) {
    this.observeOnly = observeOnly;
    this.state = State.WAITING_BRIDGE;
    this.stateMsg = '等待油猴接入';
    this.world = new WorldState();
    this.bridge = null;
    this.target = null;
    this.escapePhase = null;
    this.lastVelSent = null;
    this.lastVelAt = 0;
    this.lastShootAt = 0;
    this.loopTimer = null;
    this.lastLogged = '';
    this.escapeAttempts = 0; // 同一次受击中已尝试传送次数
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    this.lastBridgeActivityAt = Date.now();
    // 主动攻击目标锁定：当前正追着打的那名玩家的 user_id。锁定后直到其死亡/消失才换目标。
    this.aggroTargetId = null;
    // 主动攻击目标的最近观测状态：用于目标消失时判断"是死了还是跑出视野"。
    this._aggroTargetLastHp = null;
    this._aggroTargetLastPos = null;
    // 追击计时起点：目标离开射程开始追击时置为 Date.now()；追上(回到射程)或放弃时清零。
    // 超过 CONFIG.aggroChaseTimeoutMs(90s) 没打死就放弃这个人。
    this.aggroChaseSince = 0;
    // 反击锁定：已确认的攻击者 user_id。锁定后一直打这个人（不因子弹关联瞬时失败
    // 或"周围有更近的人"而换目标），直到他停止攻击/死亡/离开视野才解除。
    this.retalTargetId = null;
    this.retalChaseSince = 0;
    // 主动攻击目标被打死后，其掉落金币的待拾取记录：{x, y, at}
    this.pendingRichDrop = null;
    // 放弃追击后的目标冷却：Map<user_id, until> —— 因超时/过远放弃的目标，到期前不重新锁定。
    // 用 Map 支持多个目标同时冷却，避免单槽在 A/B 两个富人间反复切换时互相挤掉。
    this.aggroIgnore = new Map();
    // 卡住检测：持续发送移动指令但位移不足（顶到地图边界）时翻转横移方向，避免看似卡死。
    this._stuckCheckAt = 0;
    this._stuckCheckPos = null;
    this._strafeDir = 1;
  }

  start() {
    ensureDataDir();
    setLogLevel(CONFIG.logLevel);

    const cd = remainingCooldownMs();
    if (cd > 0) {
      this.state = State.OFFLINE_COOLDOWN;
      log.warn(`仍处于离线冷却，剩余约 ${Math.ceil(cd / 1000)}s`);
    }

    if (this.observeOnly) log.info('观察模式：只接收状态，不发送任何游戏动作');

    this.bridge = new BridgeServer({
      onHello: (userId) => {
        this.world.setSelf(userId);
        this.selfSyncStartedAt = typeof this.world.self?.hp === 'number' ? 0 : Date.now();
        log.info(`已绑定 user_id=${userId}`);
        // 冷却期间即使桥接重连、收到数据，也必须保持 OFFLINE_COOLDOWN 直到 180s 结束，
        // 否则会被"桥接重连成功"打断冷却，提前回到游戏。
        if (this.state === State.WAITING_BRIDGE) {
          this.state = State.WAITING_FOR_FULL_HP;
          this.escapeAttempts = 0;
        }
      },
      onMessage: (msg) => this.onGameMessage(msg),
      onDisconnect: () => {
        this.world.reset();
        this.selfSyncStartedAt = 0;
        // 桥接断开后世界数据作废：丢弃待拾取掉落、目标锁定与冷却，避免用旧数据行动。
        this.pendingRichDrop = null;
        this.aggroTargetId = null;
        this.aggroChaseSince = 0;
        this.aggroIgnore.clear();
        this.retalTargetId = null;
        this.retalChaseSince = 0;
        // 冷却期间桥接断开：保持冷却状态，不回到 WAITING_BRIDGE(否则会打断冷却)。
        if (this.state !== State.OFFLINE_COOLDOWN) {
          this.state = State.WAITING_BRIDGE;
          this.stateMsg = '油猴已断开';
        }
        this.target = null;
        this.lastVelSent = null;
      },
    });
    this.bridge.start();

    // 100ms 心跳对齐真实客户端(50ms 评估 + 100ms 节流 => 每秒 ~10 次 vel)
    this.loopTimer = setInterval(() => this.tick(), 100);
  }

  onGameMessage(msg) {
    this.lastBridgeActivityAt = Date.now();
    this.world.applyWsMessage(msg);
    if (typeof this.world.self?.hp === 'number') this.selfSyncStartedAt = 0;
    if (msg.type === 'teleport_ok') this.onTeleportAck(true);
    else if (msg.type === 'teleport_failed') this.onTeleportAck(false, msg.error);
  }

  // ---------- 动作(带节流，observe 模式下抑制) ----------
  // 与真实客户端行为一致(已逆向验证 sendVelocity)：
  //   - 移动中即使 vel 相同也【持续重复发送】(服务器靠心跳维持移动)
  //   - 只有停止(0 0)时才去重
  //   - 100ms 节流 + 方向值去重
  setVelocity(dx, dy) {
    const vel = `${clamp1(dx)} ${clamp1(dy)}`;
    const now = Date.now();
    // 停止时去重；移动中即使相同也照发
    if (vel === '0 0' && vel === this.lastVelSent) return false;
    if (now - this.lastVelAt < VEL_THROTTLE_MS) return false;
    if (!this.emit(`vel ${vel}`)) return false;
    this.lastVelAt = now;
    this.lastVelSent = vel;
    return true;
  }

  stopMoving() {
    if (this.lastVelSent === '0 0') return false;
    if (!this.emit('vel 0 0')) return false;
    this.lastVelSent = '0 0';
    return true;
  }

  shoot(tx, ty, sx, sy) {
    const now = Date.now();
    if (now - this.lastShootAt < SHOOT_THROTTLE_MS) return false;
    if (!this.emit(`shoot ${Math.round(tx)} ${Math.round(ty)} ${Math.round(sx)} ${Math.round(sy)}`)) return false;
    this.lastShootAt = now;
    return true;
  }

  emit(cmd) {
    if (this.observeOnly) {
      log.trace(`[observe] 抑制: ${cmd}`);
      return false;
    }
    if (!this.bridge?.isConnected()) return false;
    return this.bridge.send(cmd);
  }

  // ---------- 主循环 ----------
  tick() {
    if (this.state === State.OFFLINE_COOLDOWN) {
      const rem = remainingCooldownMs();
      if (rem <= 0) {
        log.info('冷却结束，通知浏览器重新加入');
        // 丢弃下线前的角色、金币和活动时间，只接受重新加入后的新状态。
        this.world.reset();
        this.selfSyncStartedAt = 0;
        // 解除浏览器侧的重连封锁：游戏自己的 scheduleReconnect(每 1200ms 重试)
        // 会在下一次尝试时连上，从而重新进入可见实体层。
        this.bridge?.send('__rejoin');
        this.escapeAttempts = 0;
        this.state = this.bridge?.isConnected() ? State.WAITING_FOR_FULL_HP : State.WAITING_BRIDGE;
      } else {
        this.report(`离线冷却中，剩余 ${Math.ceil(rem / 1000)}s`);
      }
      return;
    }

    if (!this.bridge?.isConnected()) {
      this.state = State.WAITING_BRIDGE;
      this.report('等待浏览器油猴脚本接入…');
      return;
    }

    const self = this.world.self;
    // 桥接已连接但还在 WAITING_BRIDGE：如果已收到自身数据，自动恢复，不依赖 hello 到达。
    // (桥接重连后浏览器可能没重发 hello，导致状态卡在 WAITING_BRIDGE。)
    if (this.state === State.WAITING_BRIDGE && self && self.user_id && typeof self.hp === 'number') {
      log.info('桥接已重连且收到自身数据，自动恢复运行');
      this.state = State.WAITING_FOR_FULL_HP;
    }
    if (!self || self.hp === undefined) {
      if (this.selfSyncStartedAt && Date.now() - this.selfSyncStartedAt >= SELF_SYNC_TIMEOUT_MS) {
        this.selfSyncStartedAt = 0;
        this.leaveAndCooldown('自身状态同步超时');
        return;
      }
      this.report('等待自身状态同步…');
      return;
    }

    // 卡住检测：按当前是否在移动（上次 vel 非 0）跟踪位移；顶到边界时翻转横移方向。
    this._updateStuck(self, !!this.lastVelSent && this.lastVelSent !== '0 0');

    // 浏览器后台挂起检测：snapshot 或 pos 都是有效游戏状态更新。
    // 只检查 snapshot 会在 pos 仍持续到达时误判卡住，并在攻击判断前停止角色。
    const staleMs = CONFIG.bridgeStaleMs ?? 45000;
    const lastStateAt = Math.max(this.world.lastSnapshotAt || 0, this.world.lastPosAt || 0);
    if (lastStateAt && Date.now() - lastStateAt > staleMs) {
      const ago = Math.round((Date.now() - lastStateAt) / 1000);
      this.report(`状态卡住：${ago}s 无游戏状态更新，已请求浏览器自愈（建议用无节流浏览器长期挂机）`);
      this.stopMoving();
      // 通知油猴：尝试保活/轻量恢复。主线程若仅被节流（未彻底冻结）可恢复。
      if (!this._lastNudgeAt || Date.now() - this._lastNudgeAt > 30000) {
        this._lastNudgeAt = Date.now();
        this.bridge?.send('__nudge');
      }
      return;
    }

    // 逃生优先级最高。注意要 HP 低【且】正在被攻击才逃 ——
    // 只看 HP 会导致低血重进游戏时立刻再次离开，形成 180s 死循环。
    // 传送落地后若仍被打且 HP 仍低，会继续触发，直到传送次数用尽再下线。
    if (shouldEscape(this.world)) {
      if (this.state !== State.ESCAPING) {
        log.warn(`HP ${self.hp} < ${CONFIG.escapeHp} 且正在被攻击，进入逃生`);
        this.state = State.ESCAPING;
        this.escapePhase = null;
      }
      this.escape();
      return;
    }

    // 反击：有人攻击我（不管对方金币数量），锁定并反击。
    // 优先级仅次于逃生 —— 有人打你时先自保反击，而不是去追圈内富人。
    // HP≥85 已由上方 shouldEscape 保证（HP<85 会走下线/转移流程）。
    // 反击对象 = currentRetalTarget()：锁定已确认的攻击者 B；关联不到时原地戒备，
    // 绝不退化为"打周围的人"。
    if (isUnderAttack(this.world)) {
      const attacker = this.currentRetalTarget();
      if (attacker) {
        // 被攻击优先：让出主动攻击锁定，转向攻击者 B。
        this.aggroTargetId = null;
        this.aggroChaseSince = 0;
        this.retaliate(attacker);
        return;
      }
      // 被打但暂无法确认是谁：不攻击周围的人（避免误伤 0 金币旁观者），
      // 但也绝不站桩 —— 沿最近玩家的垂直方向横移躲子弹，直到下一帧确认攻击者。
      const near = this.world.nearestTo(self.x, self.y);
      if (near) {
        const s = strafeDirection(self, near);
        this.setVelocity(quantizeDx(s.dx * this._strafeDir), quantizeDy(s.dy * this._strafeDir));
      } else {
        this.stopMoving();
      }
      this.state = State.RETALIATING;
      this.report('受攻击但未确认攻击者，横移躲避');
      return;
    }
    // 不再被攻击：解除反击锁定，回常规行为（主动攻击/拾金）。
    this.retalTargetId = null;
    this.retalChaseSince = 0;

    // 主动攻击（锁定制）：未被攻击时，锁定圈内金币>3 的目标追到打死为止。
    // 已锁定目标即使出圈 / 金币变化也继续打，直到其死亡或消失才换目标。
    // 对射时用横向走位（垂直于连线）边移动边开火，躲对方子弹，而非站桩。
    // 体力保护：1h 体力低于保护线时不再主动锁定新目标（已有锁定战斗不中断，反击自保不受限），
    // 保住传送逃生能力。
    if (typeof self.hp === 'number' && self.hp >= CONFIG.escapeHp) {
      const stam = this.world.stamina1hMillis();
      const lowStam = stam !== null && stam <= CONFIG.aggroStaminaReserveMillis;
      if (!(lowStam && this.aggroTargetId == null)) {
        const aggro = this.currentAggroTarget();
        if (aggro) {
          this.attackRich(aggro);
          return;
        }
      }
    }

    // 反击结束后的状态转换：不再被攻击时，从反击态回到常规态。
    if (this.state === State.RETALIATING) {
      this.state = this.world.isFullHp() ? State.SCAVENGING : State.WAITING_FOR_FULL_HP;
    }

    // 未满血：严格不拾金、不主动攻击、不捡掉落（用户规则：任何时候都要 100 满血才能拾取金币）。
    // 击杀目标掉落的记录保留，等回满血后在 scavenge() 里才统一拾取。
    // 但绝不站桩 —— 附近有玩家逼近时保持横移躲子弹，避免变成活靶子。
    if (!this.world.isFullHp()) {
      if (this.state !== State.WAITING_FOR_FULL_HP) {
        this.state = State.WAITING_FOR_FULL_HP;
        this.target = null;
      }
      // 回血期间保持机动：有玩家逼近就沿垂直方向横移躲子弹，不站桩挨打。
      const near = nearestPlayer(this.world);
      if (near && near.distance <= CONFIG.evadeTriggerDistanceM * CONFIG.cmPerMeter) {
        const s = strafeDirection(self, near.player);
        this.setVelocity(quantizeDx(s.dx * this._strafeDir), quantizeDy(s.dy * this._strafeDir));
      } else {
        this.stopMoving();
      }
      const low = typeof self.hp === 'number' && self.hp < CONFIG.escapeHp;
      this.report(low
        ? `原地回血 HP ${self.hp}/${self.max_hp}${near ? '(有玩家接近，横移躲避)' : '(无人，停下回血)'}`
        : `等待满血 HP ${self.hp}/${self.max_hp}${near ? '(横移躲避中)' : ''}`);
      return;
    }

    if (this.state === State.WAITING_FOR_FULL_HP) {
      log.info('已满血，开始拾金');
      this.state = State.SCAVENGING;
      this.escapeAttempts = 0;
    }

    this.scavenge();
  }

  // 确认"谁在攻击我"：用掉血瞬间的子弹快照，找 owner_user_id = 攻击者。
  // 精确反击攻击者本人，而不是乱打"离我最近的人"。
  // strict=true：子弹确认不了攻击者就返回 null —— 绝不复原成"打最近的人"，
  // 避免攻击者的子弹一时对不上时误打旁边 0 金币的无辜玩家。
  confirmAttacker() {
    const ev = this.world.hpEvents[this.world.hpEvents.length - 1];
    if (!ev) return null;
    const ownerId = this.world.attackerFromHpEvent(ev, Date.now(), true);
    if (!ownerId) return null;
    const attacker = this.world.entities.get(ownerId);
    // 攻击者需存在且在射程内才反击
    if (!attacker) return null;
    if (distance(this.world.self, attacker) > BULLET_RANGE_M * CONFIG.cmPerMeter) return null;
    return attacker;
  }

  // 反击目标（锁定制）：锁定已确认的攻击者 B 后，一直打 B 到其死亡/消失。
  // 关键：绝不退化为"打周围的人" —— 子弹关联瞬时失败时靠锁定继续打 B，
  // 而不是因为旁边有更近的人就换目标。
  currentRetalTarget() {
    // 已有锁定：B 还活着且可见就继续打（即使当前帧关联失败也不换）。
    if (this.retalTargetId != null) {
      const t = this.world.entities.get(Number(this.retalTargetId));
      if (t && typeof t.hp === 'number' && t.hp > 0
          && typeof t.x === 'number' && typeof t.y === 'number') {
        return t;
      }
      // 攻击者已死/消失：解除锁定。
      this.retalTargetId = null;
      this.retalChaseSince = 0;
      return null;
    }
    // 无锁定：用弹道精确确认攻击者；确认成功才锁定，否则返回 null（不攻击周围的人）。
    const attacker = this.confirmAttacker();
    if (attacker) {
      this.retalTargetId = Number(attacker.user_id);
      return attacker;
    }
    return null;
  }

  retaliate(attacker = this.confirmAttacker()) {
    const self = this.world.self;
    this.state = State.RETALIATING;
    if (!self || !attacker) {
      this.stopMoving();
      this.report(`无法确认攻击者，原地戒备 HP ${self?.hp ?? '?'}`);
      return false;
    }
    const d = distance(self, attacker);
    if (d <= BULLET_RANGE_M * CONFIG.cmPerMeter) {
      // 射程内：开火 + 横向走位躲对方子弹（边反击边自保，不站桩挨打）。
      this.retalChaseSince = 0;
      const s = strafeDirection(self, attacker);
      this.setVelocity(quantizeDx(s.dx * this._strafeDir), quantizeDy(s.dy * this._strafeDir));
      this.shoot(attacker.x, attacker.y, self.x, self.y);
      this.report(`反击 ${attacker.name ?? attacker.user_id} HP ${self.hp} D=${Math.round(d)}m`);
      return true;
    }
    // 攻击者出射程（边走边打拉距离）：追上去；超过 90s 或过远则放弃锁定。
    const now = Date.now();
    if (this.retalChaseSince === 0) this.retalChaseSince = now;
    if (now - this.retalChaseSince > CONFIG.aggroChaseTimeoutMs
        || d > CONFIG.maxChaseDistanceM * CONFIG.cmPerMeter) {
      this.retalTargetId = null;
      this.retalChaseSince = 0;
      this.stopMoving();
      this.report(`追击攻击者 ${attacker.name ?? attacker.user_id} 超时/过远，放弃锁定`);
      return false;
    }
    const dir = directionTo(self, attacker);
    this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    this.report(`追击攻击者 ${attacker.name ?? attacker.user_id} D=${Math.round(d / CONFIG.cmPerMeter)}m`);
    return true;
  }

  // 清理已过期的放弃追击冷却记录（Map 里 until 已到的删除）。
  _pruneAggroIgnore() {
    const now = Date.now();
    for (const [id, until] of this.aggroIgnore) {
      if (now >= until) this.aggroIgnore.delete(id);
    }
  }

  // 主动攻击目标锁定：已锁定的目标还活着就继续追打，直到打死/消失才换目标。
  // 返回需要攻击的实体；无目标返回 null。
  currentAggroTarget() {
    // 已有锁定：目标仍存活且可见则继续打（即使已出圈 / 金币下降也不换目标）。
    if (this.aggroTargetId != null) {
      const t = this.world.entities.get(Number(this.aggroTargetId));
      if (t && typeof t.hp === 'number' && t.hp > 0
          && typeof t.x === 'number' && typeof t.y === 'number') {
        return t;
      }
      // 目标已死或离开视野：判断是否真的死亡，决定是否留下待拾取掉落。
      const observedDead = !!t && typeof t.hp === 'number' && t.hp <= 0;
      const likelyDead = observedDead || (this._aggroTargetLastHp !== null && this._aggroTargetLastHp <= 0);
      this.aggroTargetId = null;
      this.aggroChaseSince = 0;
      if (likelyDead && this._aggroTargetLastPos) {
        this.pendingRichDrop = { ...this._aggroTargetLastPos, at: Date.now() };
      } else {
        // 目标没死（只是跑出视野）：清掉待拾取，别去傻等 30s；
        // 若真是被击杀，掉落币会出现在 coinDrops，普通拾金也能捡到。
        this.pendingRichDrop = null;
      }
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      return null;
    }
    // 无锁定：从圈内金币>3 的目标里选一个（富者优先）锁定。
    // 排除所有"放弃追击冷却中"的目标（Map<userId, until>，到期自动失效），
    // 避免 A/B 两个富人间反复切换时单槽冷却互相挤掉。
    this._pruneAggroIgnore();
    const pick = chooseAggroTarget(this.world, [...this.aggroIgnore.keys()]);
    if (pick) {
      this.aggroTargetId = Number(pick.user_id);
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      return pick;
    }
    return null;
  }

  // 主动攻击高金币玩家。锁定目标后每 tick 尝试开火（shoot 自带 100ms 节流 ≈ 服务器上限），
  // 直到打死为止。记录目标最后已知坐标，若被打死则 pickRichDrop 去拾取其掉落。
  // 对射时以"横向走位 + 开火"应对：沿垂直于连线的方向移动，躲对方子弹，不站桩。
  // 目标离开射程则追击，但最长追 CONFIG.aggroChaseTimeoutMs(90s)，超时放弃这个人。
  attackRich(target) {
    const self = this.world.self;
    if (!self) return;
    this.state = State.RETALIATING;
    // 记录目标最近观测状态：目标消失时用它们判断"死了"还是"跑出视野"。
    this._aggroTargetLastHp = typeof target.hp === 'number' ? target.hp : null;
    this._aggroTargetLastPos = { x: target.x, y: target.y };

    const d = distance(self, target);
    if (d <= BULLET_RANGE_M * CONFIG.cmPerMeter) {
      // 射程内：追上/对射中，重置追击计时；开火 + 横向走位躲对方子弹。
      this.aggroChaseSince = 0;
      const s = strafeDirection(self, target);
      this.setVelocity(quantizeDx(s.dx * this._strafeDir), quantizeDy(s.dy * this._strafeDir));
      this.shoot(target.x, target.y, self.x, self.y);
    } else if (d <= CONFIG.maxChaseDistanceM * CONFIG.cmPerMeter) {
      // 出射程但仍可追：追上去打。给追击计时，90s 内没打死就放弃。
      const now = Date.now();
      if (this.aggroChaseSince === 0) this.aggroChaseSince = now;
      if (now - this.aggroChaseSince > CONFIG.aggroChaseTimeoutMs) {
        this.aggroTargetId = null;
        this.aggroChaseSince = 0;
        this._aggroTargetLastHp = null;
        this._aggroTargetLastPos = null;
        this.pendingRichDrop = null; // 目标还活着，没有掉落可捡，别去等
        this.stopMoving();
        // 冷却期内不再重新锁定同一人，防止他进出圈造成"无限追同一人"。
        this.aggroIgnore.set(Number(target.user_id), now + CONFIG.aggroGiveUpCooldownMs);
        this.report(`追击 ${target.name ?? target.user_id} 超过 ${Math.round(CONFIG.aggroChaseTimeoutMs / 1000)}s 未击杀，放弃(冷却 ${Math.round(CONFIG.aggroGiveUpCooldownMs / 1000)}s 内不重锁)`);
        return;
      }
      const dir = directionTo(self, target);
      this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    } else {
      // 追不上（目标跑出最大追逐距离）：放弃锁定，冷却期内不重锁同一个人。
      this.aggroTargetId = null;
      this.aggroChaseSince = 0;
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      this.pendingRichDrop = null;
      this.stopMoving();
      this.aggroIgnore.set(Number(target.user_id), Date.now() + CONFIG.aggroGiveUpCooldownMs);
    }
    this.report(`主动攻击 ${target.name ?? target.user_id}(${getPlayerGold(target)}币) D=${Math.round(d / CONFIG.cmPerMeter)}m HP ${self.hp}`);
  }

  // 拾取被主动攻击打死的目标掉落的金币。返回 true 表示正在处理/已处理该掉落。
  // 掉落点判定：在最近一次攻击目标坐标附近找一枚金币(宽容 500m)。
  // 目标若实际未死亡或掉落已被捡走，长时间无匹配则放弃并原地回血，避免原地发呆。
  pickRichDrop() {
    const drop = this.pendingRichDrop;
    if (!drop) return false;
    const self = this.world.self;
    if (!self) return false;

    let best = null;
    let bestD = Infinity;
    for (const coin of this.world.coinDrops.values()) {
      if (typeof coin.x !== 'number' || typeof coin.y !== 'number') continue;
      const d = Math.hypot(coin.x - drop.x, coin.y - drop.y);
      if (d < bestD) { bestD = d; best = coin; }
    }

    if (!best || bestD > CONFIG.maxChaseDistanceM * CONFIG.cmPerMeter) {
      // 超时未找到掉落：直接放弃，继续正常拾金。不掉血时停留会让 bot 在满血时发呆。
      if (Date.now() - drop.at > CONFIG.richDropPendingTimeoutMs) {
        this.pendingRichDrop = null;
        log.info('高金币掉落超时未拾取，放弃并继续正常拾金');
        return false;
      }
      // 掉落还没出现（目标刚死/快照未刷新）：原地等待，别去捡别的金币。
      this.stopMoving();
      this.report('等待高金币掉落出现…');
      return true;
    }

    this.target = best;
    const d = distance(self, best);
    if (d <= CONFIG.pickupRadiusM * CONFIG.cmPerMeter) {
      this.stopMoving();
      this.report(`已拾取高金币掉落 @(${Math.round(best.x)},${Math.round(best.y)})`);
      this.pendingRichDrop = null;
      return true;
    }
    const dir = directionTo(self, best);
    this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    this.report(`拾取高金币掉落 @(${Math.round(best.x)},${Math.round(best.y)})`);
    return true;
  }

  // 判断目标金币是否仍存在（用 id 或坐标匹配）。
  targetStillValid() {
    if (!this.target) return false;
    for (const c of this.world.coinDrops.values()) {
      if (c.drop_id !== undefined && c.drop_id === this.target.drop_id) return true;
      if (c.id !== undefined && c.id === this.target.id) return true;
      if (c.x === this.target.x && c.y === this.target.y) return true;
    }
    return false;
  }

  scavenge() {
    const self = this.world.self;
    if (!self) return;

    // 有高金币掉落待拾取时，优先拾取(打死的目标掉落)。
    // 放在拾金逻辑之前：即使血量偏低也要先完成拾取/超时判定；
    // 若真的在被攻击，tick 顶部的逃生逻辑会先一步拦截，不会走到这里。
    if (this.pickRichDrop()) return;

    // 就近原则：每次先算当前最近金币。
    const nearest = chooseCoin(this.world);

    if (this.target && this.targetStillValid()) {
      // 已有锁定目标且仍存在：
      //  - 若出现明显更近的金币(近 30%+)，就近切换(防抖动的阈值)。
      //  - 否则继续锁定，避免每 tick 重选导致方向翻转。
      const curD = distance(self, this.target);
      if (nearest && nearest.distance < curD * 0.7) {
        this.target = nearest.coin;
        this.report(`就近切换：${Math.round(nearest.distance / CONFIG.cmPerMeter)}m < ${Math.round(curD / CONFIG.cmPerMeter)}m`);
      }
      this.moveToCoin(this.target);
      return;
    }

    // 目标失效或无目标，重新选。
    if (!nearest) {
      this.target = null;
      this.stopMoving();
      this.report(`无目标金币(可见 ${this.world.coinDrops.size} 个)`);
      return;
    }

    this.target = nearest.coin;
    this.moveToCoin(nearest.coin);
  }

  moveToCoin(coin) {
    const self = this.world.self;
    if (!self) return;
    const d = distance(self, coin);
    if (d <= CONFIG.pickupRadiusM * CONFIG.cmPerMeter) {
      this.stopMoving();
      this.report(`拾取中 @(${Math.round(coin.x)},${Math.round(coin.y)})`);
      return;
    }
    const dir = directionTo(self, coin);
    // 实测：服务器只认整数方向(-1,0,1)，小数方向角色不动。统一整数量化。
    this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    this.report(`前往金币 D=${Math.round(d / CONFIG.cmPerMeter)}m @(${Math.round(coin.x)},${Math.round(coin.y)})`);
  }

  // ---------- 逃生 ----------
  // 优先级：固定安全点 -> 远离攻击者的随机点 -> 按血量选择反击或下线。
  // 随机点落地后若仍被打且 HP 仍低，可再传，直到 maxEscapeTeleports 次后下线。
  pickEscapeTarget() {
    const maxTries = CONFIG.maxEscapeTeleports ?? 2;
    // 第一次优先固定安全点；之后或没有配置时用随机远离点
    if (this.escapeAttempts === 0 && Array.isArray(CONFIG.safeTeleport) && CONFIG.safeTeleport.length >= 2) {
      return { pos: CONFIG.safeTeleport, label: CONFIG.safeTeleportName || '安全点' };
    }
    if (this.escapeAttempts < maxTries) {
      const attacker = this.confirmAttacker() || nearestPlayer(this.world)?.player || null;
      const pos = chooseRandomEscapePosition(this.world, attacker);
      if (pos) return { pos, label: '随机远离点' };
    }
    return null;
  }

  escape() {
    if (this.escapePhase === 'teleporting') return;

    if (!this.world.canTeleport()) {
      this.handleEscapeFailure('传送体力不足(1h/1d 不够 1500)');
      return;
    }

    const pick = this.pickEscapeTarget();
    if (!pick) {
      this.handleEscapeFailure('传送次数用尽或无法选点');
      return;
    }

    this.stopMoving();
    const [x, y] = pick.pos;
    if (this.emit(`tp ${Math.round(x)} ${Math.round(y)}`)) {
      this.escapePhase = 'teleporting';
      this.escapeAttempts += 1;
      this.report(`逃生：传送到${pick.label} (#${this.escapeAttempts}) @(${Math.round(x)},${Math.round(y)})`);
      this.tpTimer = setTimeout(() => {
        if (this.escapePhase === 'teleporting') this.handleEscapeFailure('传送超时');
      }, CONFIG.teleportTimeoutMs ?? 5000);
      return;
    }

    this.handleEscapeFailure('传送指令发送失败');
  }

  // 逃生失败处理：逃生即下线（不尝试传送失败后改反击），统一走 leaveAndCooldown。
  handleEscapeFailure(reason) {
    clearTimeout(this.tpTimer);
    this.escapePhase = null;
    this.leaveAndCooldown(reason);
  }

  onTeleportAck(ok, error) {
    if (this.escapePhase !== 'teleporting') return;
    clearTimeout(this.tpTimer);
    if (ok) {
      log.info('传送成功，清除旧受击记录并等待满血');
      this.escapePhase = null;
      this.escapeAttempts = 0;
      this.lastTacticalTeleportAttackAt = 0;
      this.world.clearAttackHistory();
      // 已传离原区域：旧目标掉落的金币已不可及，清空待拾取与目标冷却，避免回去白等。
      this.pendingRichDrop = null;
      this.aggroIgnore.clear();
      this.state = State.WAITING_FOR_FULL_HP;
    } else {
      this.handleEscapeFailure('传送失败: ' + (error || '未知'));
    }
  }

  leaveAndCooldown(reason) {
    markOfflineCooldown(CONFIG.offlineCooldownSec);
    const sec = CONFIG.offlineCooldownSec;
    log.warn(`离开游戏(${reason})，进入 ${sec}s 离线冷却`);
    this.escapePhase = null;
    this.escapeAttempts = 0;
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    clearTimeout(this.tpTimer);
    this.stopMoving();
    // 下线后世界作废：清空掉落待拾取与目标锁定，避免重连后去捡不存在的金币。
    this.pendingRichDrop = null;
    this.aggroIgnore.clear();
    // 让油猴脚本点"离开"退出可见实体层
    this.bridge?.send('__leave');
    this.state = State.OFFLINE_COOLDOWN;
    this.target = null;
    this.aggroTargetId = null;
    this.aggroChaseSince = 0;
    this.retalTargetId = null;
    this.retalChaseSince = 0;
  }

  // 卡住检测：持续发送移动指令(moving=true)但一段时间内几乎没位移（顶到地图边界/被挡住），
  // 翻转横移方向(_strafeDir)，避免看起来"卡死"在原地。停下时不跟踪。
  _updateStuck(self, moving) {
    const now = Date.now();
    if (!moving || !self || typeof self.x !== 'number') {
      this._stuckCheckAt = 0;
      this._stuckCheckPos = null;
      return;
    }
    if (!this._stuckCheckAt) {
      this._stuckCheckAt = now;
      this._stuckCheckPos = { x: self.x, y: self.y };
      return;
    }
    const window = CONFIG.evadeStuckWindowMs ?? 8000;
    const minMove = (CONFIG.evadeStuckMinMoveM ?? 10) * CONFIG.cmPerMeter;
    if (now - this._stuckCheckAt >= window) {
      const moved = Math.hypot(self.x - this._stuckCheckPos.x, self.y - this._stuckCheckPos.y);
      if (moved < minMove) {
        this._strafeDir = -this._strafeDir; // 卡住：翻转横移方向
        log.warn(`检测到卡住(位移不足)，翻转横移方向`);
      }
      this._stuckCheckAt = now;
      this._stuckCheckPos = { x: self.x, y: self.y };
    }
  }

  // 状态变化才打印，避免刷屏
  report(msg) {
    this.stateMsg = msg;
    const line = `[${this.state}] ${msg}`;
    if (line !== this.lastLogged) {
      this.lastLogged = line;
      log.info(line);
    }
  }
}

function clamp1(v) {
  return Math.max(-1, Math.min(1, Number(v) || 0));
}

// 把归一化方向向量量化成 8 方向离散值(真实客户端只发 -1/0/1)。
// 每轴独立：|分量| ≥ 0.5 就取 ±1，否则 0。这样方向(0.87,0.49) -> (1,0)，走主要轴向。
function quantizeDx(dx) {
  return Math.abs(dx) >= 0.5 ? Math.sign(dx) : 0;
}
function quantizeDy(dy) {
  return Math.abs(dy) >= 0.5 ? Math.sign(dy) : 0;
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bot = new BridgeBot({ observeOnly: process.argv.includes('--observe') });
  bot.start();

  // --test-leave：启动后等桥接连上，立刻模拟一次逃生下线，用于验证
  // 「下线 -> 180s 冷却 -> 自动重连」整条链路。
  if (process.argv.includes('--test-leave')) {
    const t = setInterval(() => {
      if (bot.bridge?.isConnected()) {
        clearInterval(t);
        log.info('--test-leave：桥接已连接，模拟逃生下线');
        bot.leaveAndCooldown('手动测试');
      }
    }, 1000);
  }

  process.on('SIGINT', () => {
    log.info('收到中断，停止移动并退出');
    try {
      bot.stopMoving();
      bot.bridge?.close();
    } catch { /* 退出路径忽略异常 */ }
    process.exit(0);
  });
  process.on('unhandledRejection', (e) => log.error('未处理拒绝:', e?.message));
}
