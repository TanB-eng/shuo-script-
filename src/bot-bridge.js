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
import { chooseCoin, shouldEscape, chooseRandomEscapePosition, nearestPlayer, isUnderAttack } from './strategy.js';
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
    this.escapeFailureMode = null;
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    this.lastBridgeActivityAt = Date.now();
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
      this.escape('logout');
      return;
    }

    // HP≥90 受到新攻击时也优先传送；同一次掉血只尝试一次。
    // 传送不可用/失败时才反击，避免每个 tick 重复尝试传送。
    if (isUnderAttack(this.world)) {
      const attackAt = this.world.hpEvents[this.world.hpEvents.length - 1]?.at || 0;
      if (this.escapePhase === 'teleporting') {
        return;
      }
      if (attackAt && attackAt !== this.lastTacticalTeleportAttackAt) {
        this.lastTacticalTeleportAttackAt = attackAt;
        log.warn(`HP ${self.hp} ≥ ${CONFIG.escapeHp} 且受到攻击，优先传送避战`);
        this.state = State.ESCAPING;
        this.escapePhase = null;
        this.escape('retaliate');
        return;
      }
    }

    // 反击必须排在「等待回血」之前 ——
    // 否则 HP 90~99 挨打时会被回血等待挡住(直接 return)，站着挨打到掉破 90 才逃。
    const attacker = this.confirmAttacker();
    if (attacker) {
      this.retaliate(attacker);
      return;
    }
    if (this.state === State.RETALIATING) {
      this.state = this.world.isFullHp() ? State.SCAVENGING : State.WAITING_FOR_FULL_HP;
    }

    // 未满血不拾金、不移动
    if (!this.world.isFullHp()) {
      if (this.state !== State.WAITING_FOR_FULL_HP) {
        this.state = State.WAITING_FOR_FULL_HP;
        this.target = null;
      }
      this.stopMoving();
      const low = typeof self.hp === 'number' && self.hp < CONFIG.escapeHp;
      this.report(low
        ? `原地回血 HP ${self.hp}/${self.max_hp}(无人攻击，不离开)`
        : `等待满血 HP ${self.hp}/${self.max_hp}`);
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
  confirmAttacker() {
    const ev = this.world.hpEvents[this.world.hpEvents.length - 1];
    if (!ev) return null;
    const ownerId = this.world.attackerFromHpEvent(ev);
    if (!ownerId) return null;
    const attacker = this.world.entities.get(ownerId);
    // 攻击者需存在且在射程内才反击
    if (!attacker) return null;
    if (distance(this.world.self, attacker) > BULLET_RANGE_M * CONFIG.cmPerMeter) return null;
    return attacker;
  }

  retaliate(attacker = this.confirmAttacker()) {
    const self = this.world.self;
    this.state = State.RETALIATING;
    this.stopMoving();
    if (!self || !attacker) {
      this.report(`无法确认攻击者，原地戒备 HP ${self?.hp ?? '?'}`);
      return false;
    }
    const d = distance(self, attacker);
    if (d <= BULLET_RANGE_M * CONFIG.cmPerMeter) {
      this.shoot(attacker.x, attacker.y, self.x, self.y);
      this.report(`反击 ${attacker.name ?? attacker.user_id} HP ${self.hp} D=${Math.round(d)}m`);
      return true;
    }
    this.report(`攻击者超出射程 D=${Math.round(d)}m，原地戒备 HP ${self.hp}`);
    return false;
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

  escape(failureMode = 'logout') {
    this.escapeFailureMode = failureMode;
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
      }, 5000);
      return;
    }

    this.handleEscapeFailure('传送指令发送失败');
  }

  handleEscapeFailure(reason) {
    clearTimeout(this.tpTimer);
    this.escapePhase = null;
    const highHpFallback = this.escapeFailureMode === 'retaliate'
      && typeof this.world.self?.hp === 'number'
      && this.world.self.hp >= CONFIG.escapeHp;
    this.escapeFailureMode = null;
    if (highHpFallback) {
      this.escapeAttempts = 0;
      log.warn(`${reason}，改为反击`);
      this.retaliate();
      return;
    }
    this.leaveAndCooldown(reason);
  }

  onTeleportAck(ok, error) {
    if (this.escapePhase !== 'teleporting') return;
    clearTimeout(this.tpTimer);
    if (ok) {
      log.info('传送成功，清除旧受击记录并等待满血');
      this.escapePhase = null;
      this.escapeFailureMode = null;
      this.escapeAttempts = 0;
      this.lastTacticalTeleportAttackAt = 0;
      this.world.clearAttackHistory();
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
    this.escapeFailureMode = null;
    this.escapeAttempts = 0;
    this.lastTacticalTeleportAttackAt = 0;
    this.selfSyncStartedAt = 0;
    clearTimeout(this.tpTimer);
    this.stopMoving();
    // 让油猴脚本点"离开"退出可见实体层
    this.bridge?.send('__leave');
    this.state = State.OFFLINE_COOLDOWN;
    this.target = null;
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
