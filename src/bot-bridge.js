// 桥接版主程序：Node 做决策大脑，浏览器(油猴脚本)持有真正的游戏连接。
//
// 为什么不用原来的 src/index.js：Cloudflare 按 TLS 指纹拦截 Node 原生 WS(持续 502)。
// 这里把传输层换成本机桥接，其余决策逻辑全部复用现有模块。
//
// 复用：state.js / strategy.js / cooldown.js / logger.js / config.js
// 替换：comms.js(直连 wss://) -> bridge.js(本机桥接)

import { CONFIG, PROTOCOL, ensureDataDir } from './config.js';
import { setLogLevel, log } from './logger.js';
import { BridgeServer } from './bridge.js';
import { WorldState, directionTo, distance } from './state.js';
import { chooseCoin, chooseAggroTarget, getPlayerGold, shouldEscape, chooseRandomEscapePosition, nearestPlayer, isUnderAttack, strafeDirection, leadPoint } from './strategy.js';
import { markOfflineCooldown, remainingCooldownMs, escalateOfflineCooldown, resetOfflineCooldownTier } from './cooldown.js';
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
// 同一类状态消息（抹掉数字后相同）的最小重复打印间隔，防止数值抖动刷屏。
// 3s：10s 太长会让人误以为 bot 卡住；3s 既能看出在动，又不会 20 行/秒刷屏。
const REPORT_MIN_INTERVAL_MS = 3000;

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
    // 日志节流：Map<消息指纹, 最近打印时间>。按指纹各自记时，防止交替消息绕过节流刷屏。
    this._reportSeen = new Map();
    // 无效交火拉黑：Map<user_id, until>。持续开火不掉血的目标暂时不打。
    this._ineffective = new Map();
    // 无效交火追踪：{ id, since, startHp, lastHp }
    this._fireEffect = null;
    // 实测采样：开火体力消耗
    this._costSamples = [];
    this.escapeAttempts = 0; // 同一次受击中已尝试传送次数
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    this.lastBridgeActivityAt = Date.now();
    // 主动攻击目标锁定：当前正追着打的那名玩家的 user_id。锁定后直到其死亡/消失才换目标。
    this.aggroTargetId = null;
    // 锁定起点(epoch ms)：用于"主动锁定目标持续打不动"的 90s 总超时。
    this._aggroLockedSince = 0;
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
    // 战术换位（低血+有人逼近但没挨打）最近一次传送时间，用于冷却。
    this._lastRepositionAt = 0;
    // 主动攻击目标被打死后，其掉落金币的待拾取记录：{x, y, at}
    this.pendingRichDrop = null;
    // 放弃追击后的目标冷却：Map<user_id, until> —— 因超时/过远放弃的目标，到期前不重新锁定。
    // 用 Map 支持多个目标同时冷却，避免单槽在 A/B 两个富人间反复切换时互相挤掉。

    // 卡住检测：持续发送移动指令但位移不足（顶到地图边界）时翻转横移方向，避免看似卡死。
    this._stuckCheckAt = 0;
    this._stuckCheckPos = null;
    this._strafeDir = 1;
    // 卡住绕行截止时间：期间给移动方向叠加垂直偏移，真正换一条路线。
    this._detourUntil = 0;
    // 弹道提前量实测：子弹速度(cm/s)，null=尚未测到(测到前打当前位置)。
    this._bulletSpeedCmS = null;
    this._lastOwnBullet = null;   // {x, y, at} 上一帧里离枪口最近的我方子弹
    this._bulletSamples = [];     // 子弹速度采样，攒够取中位数
    // 落地重定向：逃生下线后若复活点被蹲，回来后先朝远离上次威胁方向转移再恢复行事。
    this._escapeThreat = null;    // 逃生时的攻击者/最近玩家位置，用于反向选点
    this._relocateTarget = null;  // {x, y} 正在转移的目标；null=不在转移
    this._pendingRelocate = false;// 本下线是"逃生"而非技术性下线 => 回来后要转移
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
        this._ineffective.clear();
        this._resetFireEffect();
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

  // 当前允许的射击间隔(毫秒)：按 5s 体力窗口自适应。
  //   体力充足  -> 服务器上限 100ms/发（开局爆发）
  //   体力中等  -> 可持续速率，保证"边走位边打"不会打空
  //   低于地板  -> 返回 null 表示【停火】，把体力全留给移动
  // 依据(官方规则)：5s 窗口 10 点、回复 2 点/秒；移动 1 点/秒；开火 0.3~0.5 点/发。
  // 脉冲走位占空比 0.4 => 移动耗 0.4 点/秒，可留 ~1.6 点/秒给射击。
  fireIntervalMs() {
    const s5 = this.world.self?.stamina_5s_remaining_milli;
    if (typeof s5 !== 'number') return SHOOT_THROTTLE_MS; // 未知则按上限，交由地板逻辑兜底
    const floor = CONFIG.fireStaminaFloorMilli;
    if (s5 <= floor) return null; // 停火保移动
    const cost = Math.max(1, CONFIG.fireCostMilli);
    const cap = PROTOCOL.staminaLimitsMillis.s5;
    // 体力越接近满就越敢爆发：>70% 用服务器上限
    if (s5 >= cap * 0.7) return SHOOT_THROTTLE_MS;
    // 否则按"可持续预算"计算：回复 2 点/秒 - 走位 0.4 点/秒 ≈ 1.6 点/秒可用于射击
    const duty = CONFIG.strafePulseRunMs / (CONFIG.strafePulseRunMs + CONFIG.strafePulsePauseMs);
    const regenPerSec = (cap / 5000) * 1000;          // 每秒回复的毫值(=2000)
    const movePerSec = 1000 * duty;                    // 走位每秒耗毫值
    const budgetPerSec = Math.max(0, regenPerSec - movePerSec);
    if (budgetPerSec <= 0) return null;
    const shotsPerSec = budgetPerSec / cost;
    if (shotsPerSec <= 0) return null;
    return Math.max(SHOOT_THROTTLE_MS, Math.round(1000 / shotsPerSec));
  }

  shoot(tx, ty, sx, sy) {
    const now = Date.now();
    const interval = this.fireIntervalMs();
    if (interval === null) {
      // 体力见底：停火。低频告警，避免刷屏。
      if (!this._noFireStamWarnAt || now - this._noFireStamWarnAt > 5000) {
        this._noFireStamWarnAt = now;
        const s5 = this.world.self?.stamina_5s_remaining_milli;
        log.warn(`5s体力不足(${(s5 ?? 0) / 1000}点)，停火保移动`);
      }
      return false;
    }
    if (now - this.lastShootAt < interval) return false;
    // 实测用：记录开火前的体力与目标 HP，供 _measureShot 在下一帧比对
    this._preShot = {
      at: now,
      s5: this.world.self?.stamina_5s_remaining_milli,
      targetId: this._measureTargetId ?? null,
      targetHp: this._measureTargetHp ?? null,
    };
    if (!this.emit(`shoot ${Math.round(tx)} ${Math.round(ty)} ${Math.round(sx)} ${Math.round(sy)}`)) return false;
    this.lastShootAt = now;
    return true;
  }

  // 诊断"圈内有富人却没主动攻击"的具体原因。
  // 这类问题反复出现且很难靠猜定位，所以让 bot 自己说明被哪个门槛拦住。
  // 低频打印（每 8s 一次），只在确实存在"够格但没打"的目标时才输出。
  _diagnoseAggroSkip(self, { lowStam, stam, holdForDrop, hpTooLow } = {}) {
    const now = Date.now();
    if (this._lastAggroDiagAt && now - this._lastAggroDiagAt < 8000) return;

    // 找出圈内金币>3、活着的候选（不套用任何排除规则），用于判断"是否本该打"
    const cands = [];
    for (const p of this.world.visiblePlayers()) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (typeof p.hp === 'number' && p.hp <= 0) continue;
      const d = distance(self, p);
      if (d > CONFIG.aggroRadiusCm) continue;
      if (getPlayerGold(p) <= CONFIG.aggroMinGold) continue;
      cands.push({ p, d });
    }
    if (cands.length === 0) return; // 圈内没有够格目标，不打是正常的
    cands.sort((a, b) => a.d - b.d);
    const { p, d } = cands[0];
    const who = `${p.name ?? p.user_id}(${getPlayerGold(p)}币, D=${Math.round(d / CONFIG.cmPerMeter)}m)`;

    let reason;
    if (hpTooLow) {
      reason = `HP ${self.hp} < ${CONFIG.escapeHp}，按规则先回血不开战`;
    } else if (holdForDrop) {
      reason = '正等着捡上一个击杀的掉落（捡完就打）';
    } else if (lowStam) {
      reason = `1h体力 ${Math.round((stam ?? 0) / 1000)} 点 ≤ 门槛 ${CONFIG.aggroStaminaReserveMillis / 1000} 点`;
    } else if (this._ineffective.has(Number(p.user_id))) {
      const left = Math.ceil((this._ineffective.get(Number(p.user_id)) - now) / 1000);
      reason = `该目标处于"无效交火"拉黑中（还剩 ${left}s）`;
    } else {
      reason = '未知（目标应当可打，请把这条日志发给开发者）';
    }
    this._lastAggroDiagAt = now;
    log.warn(`未主动攻击 ${who}：${reason}`);
  }

  // 无效交火检测：持续开火但目标 HP 一点没掉 -> 判定无效并脱离。
  // 覆盖三种白烧体力的场景，且【不依赖任何未知协议字段】：
  //   · 目标处于无敌期(官方教程提到重生有 INV，但协议字段表里没有该字段)
  //   · 子弹全部打空(远距离 + 目标横向移动)
  //   · 锁定了错误目标
  //
  // 2026-08-09 实测修正：此前目标一跑出射程(追击中)计时仍累计，追回来 6s 无伤就拉黑，
  // 用户要求的"打死他为止"被打断。现在：
  //   · 仅当目标在有效射程内(inRange)才累计无伤时间；出射程暂停，回射程重新计时
  //   · 主动锁定并追击的目标(aggroTargetId)不因"暂时无伤"拉黑，追到 90s 总超时再放弃
  //   · 只有非锁定目标(误锁/站桩无敌)才拉黑 30s
  _trackFireEffect(target, now, inRange = true) {
    const id = Number(target.user_id);
    const hp = typeof target.hp === 'number' ? target.hp : null;
    if (!this._fireEffect || this._fireEffect.id !== id) {
      this._fireEffect = { id, since: now, startHp: hp, lastHp: hp };
      return;
    }
    const fe = this._fireEffect;
    // 只要 HP 掉过一次，就说明打得中 —— 重置计时窗口
    if (hp !== null && fe.lastHp !== null && hp < fe.lastHp) {
      const dmg = fe.lastHp - hp;
      log.info(`[实测] 命中 ${target.name ?? id}：HP ${fe.lastHp} -> ${hp}（本次掉 ${dmg}）`);
      fe.since = now;
      fe.startHp = hp;
    }
    fe.lastHp = hp;

    // 目标不在有效射程内（追击中/跑远）：这段时间的"无伤"不算数，暂停计时。
    // 回到射程后从此刻重新累计，避免"追了 9 秒刚回来就被 6s 判定拉黑"。
    if (!inRange) {
      fe.since = now;
      return;
    }

    if (now - fe.since <= CONFIG.ineffectiveFireMs) return;

    // 主动锁定并追击的目标：不因"暂时打不掉"拉黑 —— 用户要求"打死他为止"。
    // 但要防"目标真的无敌"无限白烧体力：锁定总时长超过 aggroChaseTimeoutMs(90s) 才放弃。
    if (this.aggroTargetId === id) {
      const lockedSince = this._aggroLockedSince || now;
      if (now - lockedSince > CONFIG.aggroChaseTimeoutMs) {
        log.warn(`对 ${target.name ?? id} 持续开火 ${Math.round(CONFIG.ineffectiveFireMs / 1000)}s 无伤且锁定已 ${Math.round((now - lockedSince) / 1000)}s，判定打不动，放弃`);
        this.aggroTargetId = null;
        this.aggroChaseSince = 0;
        this._aggroTargetLastHp = null;
        this._aggroTargetLastPos = null;
        this.pendingRichDrop = null;
        this._aggroLockedSince = 0;
        this._resetFireEffect();
        this.stopMoving();
        return;
      }
      // 还在 90s 内：不拉黑、不脱离，继续追打。
      log.warn(`对 ${target.name ?? id} 持续开火 ${Math.round(CONFIG.ineffectiveFireMs / 1000)}s 未造成伤害，但该目标是我主动锁定的，继续追打`);
      this._resetFireEffect();
      return;
    }

    // 非锁定目标（误锁/站桩无敌）：拉黑并脱离。
    this._ineffective.set(id, now + CONFIG.ineffectiveBlacklistMs);
    log.warn(`对 ${target.name ?? id} 持续开火 ${Math.round(CONFIG.ineffectiveFireMs / 1000)}s 未造成伤害（可能无敌/全打空），放弃并拉黑 ${Math.round(CONFIG.ineffectiveBlacklistMs / 1000)}s`);
    this.aggroTargetId = null;
    this.aggroChaseSince = 0;
    this._aggroTargetLastHp = null;
    this._aggroTargetLastPos = null;
    this.pendingRichDrop = null;
    this._aggroLockedSince = 0;
    this._resetFireEffect();
    this.stopMoving();
  }

  _resetFireEffect() {
    this._fireEffect = null;
  }

  // 清理过期的无效交火拉黑记录
  _pruneIneffective(now = Date.now()) {
    for (const [id, until] of this._ineffective) {
      if (now >= until) this._ineffective.delete(id);
    }
  }

  // 实测开火体力消耗：把开火前后的 5s 体力差打出来，用于校准 fireCostMilli
  // （教程写 0.5 点/发、体力说明图写 0.3 点/发，存在分歧）。
  _measureFireCost() {
    const pre = this._preShot;
    if (!pre || typeof pre.s5 !== 'number') return;
    const nowS5 = this.world.self?.stamina_5s_remaining_milli;
    if (typeof nowS5 !== 'number') return;
    this._preShot = null;
    const spent = pre.s5 - nowS5;
    // 只在合理区间内采样（同时受回复影响，取近似）
    if (spent > 0 && spent < 2000) {
      this._costSamples.push(spent);
      if (this._costSamples.length >= 20) {
        const avg = this._costSamples.reduce((a, b) => a + b, 0) / this._costSamples.length;
        log.info(`[实测] 开火体力消耗均值 ≈ ${(avg / 1000).toFixed(2)} 点/发（配置值 ${CONFIG.fireCostMilli / 1000}），样本 ${this._costSamples.length}`);
        this._costSamples.length = 0;
      }
    }
  }

  // 实测子弹速度(cm/s)：用自己发射的子弹跨两帧的位移 ÷ 帧间隔。
  // 打脚本需要提前量，但子弹速度协议里没给、也不该猜，运行时量。
  // 方法：每帧挑"离我枪口最近的"我方子弹（=最新发射的那颗），对上一帧同一颗算速度。
  // 样本取中位数(抗噪)、只接受合理区间。
  //
  // 2026-08-09 修正：此前要攒满 12 样本才生效，但实测里我方射速被 5s 体力掐得很稀疏，
  // 样本永远凑不齐，导致 bulletSpeedCmS 一直是 null、提前量从未生效（等于打当前位置）。
  // 现在：
  //   · 初始值用 CONFIG.bulletSpeedCmS（估算）兜底，让提前量立刻生效；
  //   · 实测门槛降到 6 样本，且每 30s 未出结果就打印一次进度，便于确认测量是否在推进。
  _measureBulletSpeed(now = Date.now()) {
    const self = this.world.self;
    const myId = Number(self?.user_id);
    if (!myId) return;
    const bullets = (this.world.bullets || []).filter((b) =>
      Number(b?.owner_user_id) === myId && typeof b.x === 'number' && typeof b.y === 'number');
    if (bullets.length === 0) { this._lastOwnBullet = null; return; }

    // 离枪口最近 = 最新发射
    let freshest = bullets[0];
    let best = Infinity;
    for (const b of bullets) {
      const dd = (b.x - self.x) ** 2 + (b.y - self.y) ** 2;
      if (dd < best) { best = dd; freshest = b; }
    }

    if (this._lastOwnBullet) {
      const dt = now - this._lastOwnBullet.at;
      if (dt > 0 && dt <= 2500) {
        const dist = Math.hypot(freshest.x - this._lastOwnBullet.x, freshest.y - this._lastOwnBullet.y);
        const speed = dist / (dt / 1000); // cm/s
        if (speed >= (CONFIG.bulletSpeedSampleMinCmS ?? 10000)
            && speed <= (CONFIG.bulletSpeedSampleMaxCmS ?? 100000)) {
          this._bulletSamples.push(speed);
          if (this._bulletSamples.length >= 6) {
            const sorted = [...this._bulletSamples].sort((a, b) => a - b);
            const med = sorted[Math.floor(sorted.length / 2)];
            this._bulletSpeedCmS = med;
            log.info(`[实测] 子弹速度 ≈ ${Math.round(med / 100)} m/s（样本 ${this._bulletSamples.length}）`);
            this._bulletSamples.length = 0; // 周期复测，应对服务器可能调整弹速
          }
        }
      }
    }
    this._lastOwnBullet = { x: freshest.x, y: freshest.y, at: now };
  }

  // 弹道提前目的瞄准点：优先用实测速度；未测到时用 config 估算值兜底，让提前量立刻生效。
  _leadPoint(target) {
    const speed = this._bulletSpeedCmS || CONFIG.bulletSpeedCmS;
    if (!speed) return { x: target.x, y: target.y };
    return leadPoint(this.world.self, target, speed);
  }

  // 落地重定向：逃生下线后重连，若复活点被蹲，先朝远离上次威胁的方向走一段。
  // 返回 true = 仍在转移(本 tick 应停止后续行动)；false = 未转移或已完成。
  _maybeRelocate() {
    const self = this.world.self;
    // 非逃生下线无需转移；有要在转移的目标时继续直到到达
    if (!this._pendingRelocate) { this._relocateTarget = null; return false; }
    if (!self || typeof self.x !== 'number' || typeof self.y !== 'number') return false; // 还没落地

    let target = this._relocateTarget;
    if (!target) {
      // 首次构造转移点：沿"远离上次威胁"的方向推 relocateDistM；
      // 没有威胁信息(如未知攻击者)就随机半正方，避免原地送死。
      const dist = (CONFIG.relocateDistM ?? 800) * CONFIG.cmPerMeter;
      let dir;
      if (this._escapeThreat && typeof this._escapeThreat.x === 'number') {
        const t = this._escapeThreat;
        const dx = self.x - t.x, dy = self.y - t.y;
        const len = Math.hypot(dx, dy);
        dir = len > 1e-6 ? { dx: dx / len, dy: dy / len } : { dx: 1, dy: 0 };
      } else {
        const ang = Math.random() * Math.PI * 2;
        dir = { dx: Math.cos(ang), dy: Math.sin(ang) };
      }
      target = { x: self.x + dir.dx * dist, y: self.y + dir.dy * dist };
      this._relocateTarget = target;
      this._pendingRelocate = false; // 目标一经选定，只认目标点直到走够
    }

    const d = Math.hypot(target.x - self.x, target.y - self.y);
    if (d <= (CONFIG.relocateArriveM ?? 120) * CONFIG.cmPerMeter) {
      this._relocateTarget = null;
      this._escapeThreat = null;
      this.report('落地转移完成，恢复行事');
      return false;
    }
    const dir = directionTo(self, { x: target.x, y: target.y });
    this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    this.report(`落地转移：远离复活点 ${Math.round(d / CONFIG.cmPerMeter)}m`);
    return true;
  }

  // 脉冲走位：跑 strafePulseRunMs、停 strafePulsePauseMs 循环。
  // 目的：既不站桩(打断对方瞄准)，又把移动体力压到占空比 0.4，
  // 从而给射击留出 ~1.6 点/秒预算（持续移动只能留 1 点/秒）。
  // 返回 true 表示"本刻应当移动"。
  _strafePulseOn(now = Date.now()) {
    const run = CONFIG.strafePulseRunMs;
    const pause = CONFIG.strafePulsePauseMs;
    const period = run + pause;
    if (period <= 0) return true;
    return (now % period) < run;
  }

  // 前往某点的方向：正常走直线；【卡住绕行期】叠加垂直偏移换一条路线。
  // 这是真正修复"拾金卡住"的关键 —— 旧实现只翻 _strafeDir，
  // 而 moveToCoin 根本不用那个变量，导致卡住检测对拾金路径完全无效
  // (实测表现：D=168m 十几分钟不变，卡住告警反复打印却毫无改善)。
  _pathDirTo(self, to) {
    const dir = directionTo(self, to);
    if (!this._detourUntil || Date.now() >= this._detourUntil) return dir;
    const side = strafeDirection(self, to);
    // 保留主要朝向(0.5) + 明显的垂直偏移(0.9)，绕开挡路的障碍/边界
    return {
      dx: dir.dx * 0.5 + side.dx * 0.9 * this._strafeDir,
      dy: dir.dy * 0.5 + side.dy * 0.9 * this._strafeDir,
    };
  }

  // 战斗中的移动决策（不呆在原地，但也不无脑持续跑）：
  //   · 距离 > fireOptimalRangeCm -> 斜向逼近：朝目标 + 侧向偏移的锯齿路线
  //     （同一份体力同时买到"缩短距离提高命中"和"不走直线躲子弹"）
  //   · 距离 <= fireOptimalRangeCm -> 脉冲横移：垂直于连线，专心走位
  //   · 体力见底 -> 交由调用方停火，这里仍然移动（保命优先）
  _combatMove(self, target, d) {
    const now = Date.now();
    const moving = this._strafePulseOn(now);
    if (!moving) {
      this.stopMoving();
      return;
    }
    const toward = directionTo(self, target);
    const side = strafeDirection(self, target);
    let dx, dy;
    if (d > CONFIG.fireOptimalRangeCm) {
      // 斜向逼近：逼近为主(0.75) + 侧向偏移(0.65) => 锯齿前进
      dx = toward.dx * 0.75 + side.dx * 0.65 * this._strafeDir;
      dy = toward.dy * 0.75 + side.dy * 0.65 * this._strafeDir;
    } else {
      dx = side.dx * this._strafeDir;
      dy = side.dy * this._strafeDir;
    }
    this.setVelocity(quantizeDx(dx), quantizeDy(dy));
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
    // 实测：采样上一次开火的体力消耗（用于校准 fireCostMilli）
    this._measureFireCost();
    // 实测：用自己射出的子弹量子弹速度，供弹道提前量(leadPoint)使用
    this._measureBulletSpeed();

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
        log.warn(`HP ${self.hp} < ${CONFIG.escapeHp} 且正在被攻击，紧急撤离`);
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

    // 落地重定向：本次下线是"逃生"(复活点被蹲)，回来后先朝远离上次威胁的方向转移，
    // 再恢复拾金/主动攻击。若返回 true 表示正在转移，本 tick 不再做别的事。
    if (this._maybeRelocate()) return;

    // 主动攻击（锁定制）：未被攻击时，锁定圈内金币>3 的目标追到打死为止。
    // 已锁定目标即使出圈 / 金币变化也继续打，直到其死亡或消失才换目标。
    // 对射时用横向走位（垂直于连线）边移动边开火，躲对方子弹，而非站桩。
    //
    // 体力保护：1h 体力低于保护线时才不主动锁定【新】目标（已有锁定不中断，反击自保不受限），
    // 保住脱离能力。门槛已压低到 80 点（实测 186 点都曾因 300 门槛被静默锁死，
    // 55 金币 Rauze 在 150m 内也不主动打）。真正不能打的是体力见底连移动都不行。
    //
    // 注意本分支在【满血判断之前】执行：只要 HP≥escapeHp(85)，回血期(85≤HP<100)
    // 也照常主动锁定圈内高币目标 —— 只有真正被打伤(HP<85)才让出主动攻击去逃。
    if (typeof self.hp === 'number' && self.hp >= CONFIG.escapeHp) {
      const stam = this.world.stamina1hMillis();
      const lowStam = stam !== null && stam <= CONFIG.aggroStaminaReserveMillis;
      // 刚打死人、掉落还没捡 -> 先去捡，别立刻锁定下一个富人（否则永远走不到拾取那一步，
      // 白打一场、金币被别人捡走）。已在战斗中(有锁定)则不打断。
      const holdForDrop = !!this.pendingRichDrop && this.aggroTargetId == null;
      if (!holdForDrop && !(lowStam && this.aggroTargetId == null)) {
        const aggro = this.currentAggroTarget();
        if (aggro) {
          this.attackRich(aggro);
          return;
        }
      }
      // 圈内明明有够格的富人却没打 -> 说明被某个门槛拦住了。
      // 把【具体原因】打出来，避免"为什么不攻击"只能靠猜。
      this._diagnoseAggroSkip(self, { lowStam, stam, holdForDrop });
    } else if (typeof self.hp === 'number') {
      this._diagnoseAggroSkip(self, { hpTooLow: true });
    }

    // 反击结束后的状态转换：不再被攻击时，从反击态回到常规态。
    if (this.state === State.RETALIATING) {
      this.state = this.world.isFullHp() ? State.SCAVENGING : State.WAITING_FOR_FULL_HP;
    }

    // 未满血：严格不拾金、不主动攻击、不捡掉落（用户规则：任何时候都要 100 满血才能拾取金币）。
    // 击杀目标掉落的记录保留，等回满血后在 scavenge() 里才统一拾取。
    if (!this.world.isFullHp()) {
      if (this.state !== State.WAITING_FOR_FULL_HP) {
        this.state = State.WAITING_FOR_FULL_HP;
        this.target = null;
      }
      // 站定不动回血。不再"边跑边躲" ——
      //   · HP<85 且附近有人 → 上方 shouldEscape 已接管（传送/下线），不会走到这里
      //   · 正在被打        → 上方反击分支已接管
      // 所以到这里意味着"没人打我、且(没人靠近 或 血量还够高)"，最优解就是站住回血：
      // 移动会阻碍回血并白烧体力，且曾因"跑不到解除距离"在 188~191m 间无限震荡。
      this.stopMoving();
      const near = nearestPlayer(this.world);
      const nearMsg = near ? ` 最近玩家 D=${Math.round(near.distance / CONFIG.cmPerMeter)}m` : '';
      this.report(`原地回血 HP ${self.hp}/${self.max_hp}(站定不动)${nearMsg}`);
      return;
    }

    if (this.state === State.WAITING_FOR_FULL_HP) {
      log.info('已满血，开始拾金');
      this.state = State.SCAVENGING;
      this.escapeAttempts = 0;
      // 逃脱了蹲点：这轮没被反复打断，把递增冷却档位清零，下次逃生回到基础 90s。
      resetOfflineCooldownTier();
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
    if (d <= CONFIG.fireMaxRangeCm) {
      // 有效开火距离内：脉冲走位 + 开火（边反击边自保，不站桩挨打）。
      // 与主动攻击共用同一套体力预算逻辑：走位占空比 0.4、射速按 5s 体力自适应。
      this.retalChaseSince = 0;
      this._combatMove(self, attacker, d);
      const aim = this._leadPoint(attacker);
      const aimD = Math.hypot(aim.x - self.x, aim.y - self.y);
      if (aimD <= (CONFIG.leadMaxRangeCm ?? CONFIG.fireMaxRangeCm)) {
        this.shoot(aim.x, aim.y, self.x, self.y);
      }
      this.report(`反击 ${attacker.name ?? attacker.user_id} HP ${self.hp} D=${Math.round(d / CONFIG.cmPerMeter)}m`);
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
      // 目标已死或离开视野：判断是否"很可能是被我打死的"，决定要不要去捡他的掉落。
      //
      // 判据（服务器击杀后通常直接移除实体、不广播 hp=0，所以不能只看 hp<=0）：
      //   · 看到 hp<=0                     -> 死了
      //   · 最后一次观测时【在我射程内】就消失了 -> 我正在打他，极可能是被我打死
      //   · 最后观测在射程外才消失            -> 他是跑掉的，不留待拾取
      // 猜错的代价可控：pickRichDrop 会去掉落点找真实金币，
      // 找不到就在 richDropPendingTimeoutMs 后自动放弃（自纠正）。
      const observedDead = !!t && typeof t.hp === 'number' && t.hp <= 0;
      const lastD = this._aggroTargetLastPos?.d;
      const vanishedInRange = typeof lastD === 'number' && lastD <= BULLET_RANGE_M * CONFIG.cmPerMeter;
      const likelyDead = observedDead || vanishedInRange;
      this.aggroTargetId = null;
      this.aggroChaseSince = 0;
      if (likelyDead && this._aggroTargetLastPos) {
        this.pendingRichDrop = {
          x: this._aggroTargetLastPos.x,
          y: this._aggroTargetLastPos.y,
          at: Date.now(),
        };
        log.info(`目标消失于射程内，判定击杀，前往拾取其掉落 @(${Math.round(this._aggroTargetLastPos.x)},${Math.round(this._aggroTargetLastPos.y)})`);
      } else {
        // 他是跑掉的：不留待拾取，避免白等。
        this.pendingRichDrop = null;
      }
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      return null;
    }
    // 无锁定：从【攻击圈内】金币>3 的目标里选一个（富者优先）锁定。
    // 不设"放弃后冷却"：用户要求追击超时放弃后，若他重新进入攻击圈就重新锁定并重新计时。
    // 由于 chooseAggroTarget 只返回圈内目标，"重锁"必然意味着他真的回到了圈内，
    // 而回到圈内会让 attackRich 把计时清零，所以不会退化成无限追同一个人。
    // 但排除"无效交火拉黑"中的目标（打不动的人，如无敌期），避免反复白烧体力。
    this._pruneIneffective();
    const pick = chooseAggroTarget(this.world, [...this._ineffective.keys()]);
    if (pick) {
      this.aggroTargetId = Number(pick.user_id);
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      // 锁定起点：用于"主动锁定目标打不动"的 90s 总超时（_trackFireEffect 里用）。
      this._aggroLockedSince = Date.now();
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

    const d = distance(self, target);
    // 记录目标最近观测状态（含当时距离）：目标消失时用来判断"被我打死了"还是"跑出视野"。
    // 距离是关键判据 —— 服务器击杀后通常直接移除实体、不广播 hp=0，
    // 所以"在我射程内突然消失"比"看到 hp<=0"可靠得多。
    this._aggroTargetLastHp = typeof target.hp === 'number' ? target.hp : null;
    this._aggroTargetLastPos = { x: target.x, y: target.y, d };

    // 追击计时以【攻击圈 aggroRadiusCm = 射程 150m】为界：
    //   · 在圈内 -> 计时清零（他还在我攻击范围内，不算"追"）
    //   · 出了圈 -> 开始计时，90s 内没击杀就放弃
    // 目标重新回到圈内会让计时清零 == 用户要求的"重新计时，继续攻击他"。
    const inAggroCircle = d <= CONFIG.aggroRadiusCm;
    const now = Date.now();
    if (inAggroCircle) {
      this.aggroChaseSince = 0;
    } else {
      if (this.aggroChaseSince === 0) this.aggroChaseSince = now;
      if (now - this.aggroChaseSince > CONFIG.aggroChaseTimeoutMs) {
        this.aggroTargetId = null;
        this.aggroChaseSince = 0;
        this._aggroTargetLastHp = null;
        this._aggroTargetLastPos = null;
        this.pendingRichDrop = null; // 目标还活着，没有掉落可捡，别去等
        this.stopMoving();
        this.report(`追击 ${target.name ?? target.user_id} 超过 ${Math.round(CONFIG.aggroChaseTimeoutMs / 1000)}s 未击杀，放弃(等血满后继续拾金)`);
        return;
      }
    }

    if (d <= CONFIG.fireMaxRangeCm) {
      // 在有效开火距离(145m)内：脉冲走位 + 开火。
      // 走位由 _combatMove 决定(远则斜向逼近、近则脉冲横移)；
      // 射速由 shoot() 按 5s 体力自适应，体力见底会自动停火只保移动。
      // 开火点用弹道提前量(leadPoint)瞄准"子弹飞行后目标的位置"，打脚本更准。
      this._measureTargetId = Number(target.user_id);
      this._measureTargetHp = typeof target.hp === 'number' ? target.hp : null;
      this._combatMove(self, target, d);
      const aim = this._leadPoint(target);
      const aimD = Math.hypot(aim.x - self.x, aim.y - self.y);
      if (aimD <= (CONFIG.leadMaxRangeCm ?? CONFIG.fireMaxRangeCm)) {
        this.shoot(aim.x, aim.y, self.x, self.y);
      }
      this._trackFireEffect(target, now, d <= CONFIG.fireMaxRangeCm);
    } else if (d <= CONFIG.maxChaseDistanceM * CONFIG.cmPerMeter) {
      // 超出有效开火距离但仍可追（含攻击圈边缘 145~150m）：先逼近，别浪费子弹。
      const dir = directionTo(self, target);
      this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
      this._resetFireEffect();
    } else {
      // 追不上（目标跑出最大追逐距离 2000m）：放弃锁定。
      // 他若重新进入攻击圈会被重新锁定并重新计时（用户规则）。
      this.aggroTargetId = null;
      this.aggroChaseSince = 0;
      this._aggroTargetLastHp = null;
      this._aggroTargetLastPos = null;
      this.pendingRichDrop = null;
      this.stopMoving();
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
    const dir = this._pathDirTo(self, coin);
    // 实测：服务器只认整数方向(-1,0,1)，小数方向角色不动。统一整数量化。
    this.setVelocity(quantizeDx(dir.dx), quantizeDy(dir.dy));
    const detour = this._detourUntil && Date.now() < this._detourUntil ? ' [绕行中]' : '';
    this.report(`前往金币 D=${Math.round(d / CONFIG.cmPerMeter)}m @(${Math.round(coin.x)},${Math.round(coin.y)})${detour}`);
  }

  // ---------- 逃生 ----------
  // 用户规则：低血挨打 -> 传送【1 次】，传送失败/用尽就下线冷却 90s。
  // 优先固定安全点；没配安全点才用"远离攻击者的随机点"兜底。
  pickEscapeTarget() {
    const maxTries = CONFIG.maxEscapeTeleports ?? 1;
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
    this.leaveAndCooldown(reason, { escalate: true });
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
      // 已传离原区域：旧目标掉落的金币已不可及，清空待拾取与交火状态，避免回去白等。
      this.pendingRichDrop = null;
      this._ineffective.clear();
      this._resetFireEffect();
      // 传送成功 = 已脱离蹲点：不需要落地转移，递增冷却也清零。
      this._pendingRelocate = false;
      this._relocateTarget = null;
      this._escapeThreat = null;
      resetOfflineCooldownTier();
      this.state = State.WAITING_FOR_FULL_HP;
    } else {
      this.handleEscapeFailure('传送失败: ' + (error || '未知'));
    }
  }

  leaveAndCooldown(reason, opts = {}) {
    const escalate = !!opts.escalate;
    let sec = CONFIG.offlineCooldownSec;
    if (escalate) {
      // 逃生：递增冷却。被蹲时反复逃生会让等待越来越长，逼对方离开/自己脱离。
      const { tier, sec: s } = escalateOfflineCooldown();
      sec = s;
      log.warn(`离开游戏(${reason})，进入 ${sec}s 离线冷却(第 ${tier} 档)`);
      // 逃生 -> 标记回来要落地转移（先脱离复活点蹲守再恢复行事）。
      this._pendingRelocate = true;
      this._relocateTarget = null;
      // 记录此刻的威胁位置：重连成功后反向选点。
      const attacker = this.confirmAttacker() || nearestPlayer(this.world)?.player || null;
      this._escapeThreat = attacker && typeof attacker.x === 'number'
        ? { x: attacker.x, y: attacker.y } : null;
    } else {
      markOfflineCooldown(CONFIG.offlineCooldownSec);
      log.warn(`离开游戏(${reason})，进入 ${sec}s 离线冷却`);
    }
    this.escapePhase = null;
    this.escapeAttempts = 0;
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    clearTimeout(this.tpTimer);
    this.stopMoving();
    // 下线后世界作废：清空掉落待拾取与目标锁定，避免重连后去捡不存在的金币。
    this.pendingRichDrop = null;
    this._ineffective.clear();
    this._resetFireEffect();
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
        // 先分清两种"不动"：体力耗尽(服务器拒绝移动) vs 真的被挡住。
        // 只翻 _strafeDir 曾是无效修复 —— 拾金路径(moveToCoin)根本不用它。
        if (!this.world.canMove()) {
          log.warn(`无法移动：体力耗尽 (${this.world.staminaSummary()} 点)，等待体力恢复`);
        } else {
          this._strafeDir = -this._strafeDir;
          // 设置绕行：让拾金/走位在一段时间内加入垂直偏移，真正换一条路线。
          this._detourUntil = now + (CONFIG.stuckDetourMs ?? 2500);
          log.warn(`检测到卡住(位移 ${Math.round(moved / CONFIG.cmPerMeter)}m < ${CONFIG.evadeStuckMinMoveM}m)，绕行 ${Math.round((CONFIG.stuckDetourMs ?? 2500) / 1000)}s  体力 ${this.world.staminaSummary()}`);
        }
      }
      this._stuckCheckAt = now;
      this._stuckCheckPos = { x: self.x, y: self.y };
    }
  }

  // 状态变化才打印，避免刷屏。
  //
  // 去重不能只比"和上一行是否相同"：
  //   · 同一 tick 内两处 report 交替(A,B,A,B) -> 每次都与上一行不同 -> 去重失效
  //   · 消息里嵌 D=59m 这类每帧都在变的数值 -> 同理失效
  // 所以：把消息里的数字抹掉后做指纹比较，并对相同指纹加最小打印间隔。
  report(msg) {
    this.stateMsg = msg; // stateMsg 始终实时更新，只节流"打印"
    const line = `[${this.state}] ${msg}`;
    // 抹掉数字得到"消息类型"指纹：D=59m / D=60m / HP 82 视为同一类。
    const fingerprint = line.replace(/-?\d+(\.\d+)?/g, '#');
    const now = Date.now();
    // 按【每个指纹】各自记时，而不是只记全局上一条 ——
    // 否则 A,B,A,B 交替时每次指纹都"变了"，会绕过节流继续刷屏。
    const lastAt = this._reportSeen.get(fingerprint);
    if (lastAt && now - lastAt <= REPORT_MIN_INTERVAL_MS) return;
    this._reportSeen.set(fingerprint, now);
    // 防无界增长：清掉早已过期的指纹。
    if (this._reportSeen.size > 64) {
      for (const [fp, at] of this._reportSeen) {
        if (now - at > REPORT_MIN_INTERVAL_MS) this._reportSeen.delete(fp);
      }
    }
    this.lastLogged = line;
    log.info(line);
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
