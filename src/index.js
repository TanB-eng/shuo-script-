// 主程序 + 决策状态机。
//
// 决策状态机（见 spec）：
//   AUTHENTICATING -> JOINING -> WAITING_FOR_FULL_HP -> SCAVENGING
//   SCAVENGING <-> RETALIATING（仅反击确认的攻击者）
//   HP < 70 => ESCAPING => OFFLINE_COOLDOWN(180s) => REJOINING -> WAITING_FOR_FULL_HP
//
// 加入可见实体层是隐式的（WS 握手即入层，无显式 join 命令）。
// 移动为速度命令驱动（持续发 vel <dx> <dy>），而非离散坐标步进。

import { CONFIG, ensureDataDir } from './config.js';
import { setLogLevel, log } from './logger.js';
import { WsClient } from './comms.js';
import { ActionQueue } from './actions.js';
import { WorldState, directionTo, distance } from './state.js';
import { chooseCoin, shouldEscape, chooseRetaliation, nearestThreat } from './strategy.js';
import { getStoredSession, validateSession, authorize } from './auth.js';
import { markOfflineCooldown, remainingCooldownMs } from './cooldown.js';

const State = Object.freeze({
  AUTHENTICATING: 'AUTHENTICATING',
  JOINING: 'JOINING',
  WAITING_FOR_FULL_HP: 'WAITING_FOR_FULL_HP',
  SCAVENGING: 'SCAVENGING',
  RETALIATING: 'RETALIATING',
  ESCAPING: 'ESCAPING',
  OFFLINE_COOLDOWN: 'OFFLINE_COOLDOWN',
});

export class Bot {
  constructor() {
    this.state = State.AUTHENTICATING;
    this.stateMsg = '初始化';
    this.world = new WorldState();
    this.actions = new ActionQueue({ wsProvider: () => this.ws?.ws ?? null, observeOnly: CONFIG.observeOnly });
    this.ws = null;
    this.session = null;
    this._target = null; // 当前目标金币
    this._attacker = null; // 已确认的攻击者
    this._loopTimer = null;
    this._escapePhase = null; // 逃生子阶段：null | 'teleporting' | 'teleported' | 'failed'
    this._teleportTimer = null; // 传送回执超时定时器
  }

  async start() {
    ensureDataDir();
    setLogLevel(CONFIG.logLevel);

    // 复活冷却检查：进程重启后不得提前重连。
    const cooldown = remainingCooldownMs();
    if (cooldown > 0) {
      log.warn(`检测到仍处于离线冷却中（剩余约 ${Math.ceil(cooldown / 1000)}s），将先进入 OFFLINE_COOLDOWN`);
      this.state = State.OFFLINE_COOLDOWN;
    }

    // 会话。
    this.session = getStoredSession();
    if (!this.session) {
      log.info('未找到已保存会话，开始首次授权…');
      this.session = await authorize();
    } else {
      await validateSession(this.session);
    }
    log.info(`会话就绪：user_id=${this.session.userId}`);

    this._connectAndLoop();
  }

  _connectAndLoop() {
    // 停止旧循环与连接
    if (this._loopTimer) clearInterval(this._loopTimer);
    if (this.ws) this.ws.close();

    if (this.state === State.OFFLINE_COOLDOWN) {
      this._loopTimer = setInterval(() => this._tick(), 1000);
      return;
    }

    this.world.reset();
    this.world.setSelf(this.session.userId);

    this.ws = new WsClient({
      userId: this.session.userId,
      token: this.session.token,
      onMessage: (msg) => {
        this.world.applyWsMessage(msg);
        // 路由动作回执。
        if (msg.type === 'teleport_ok') this.handleTeleportAck(true);
        else if (msg.type === 'teleport_failed') this.handleTeleportAck(false, msg.error);
      },
      observeOnly: CONFIG.observeOnly,
    });
    this.ws.connect();

    this._loopTimer = setInterval(() => this._tick(), 200);
  }

  _tick() {
    if (this.state === State.OFFLINE_COOLDOWN) {
      const rem = remainingCooldownMs();
      if (rem <= 0) {
        log.info('冷却结束，重新加入');
        this.state = State.AUTHENTICATING;
        this._connectAndLoop();
      } else {
        // 主体力循环保持健康：不移动、不动作，仅重连。
        this.actions.stop();
      }
      return;
    }

    if (!this.ws?.isOpen()) {
      // WS 断开：停止动作，等待重连（WsClient 自己展开退避，主循环仅兜底）
      return;
    }

    const now = Date.now();
    const self = this.world.self;

    // 尚未加入（未收到自身实体）-> JOINING
    if (this.state === State.AUTHENTICATING) {
      if (this.world.selfJoined(now)) {
        this.state = State.WAITING_FOR_FULL_HP;
        this.stateMsg = '已加入，等待满血';
        log.info('已进入可见实体层（检测到自身实体），等待满血');
      } else {
        this.state = State.JOINING;
        this.stateMsg = '加入中';
        if (this.world.lastSnapshotAt && now - this.world.lastSnapshotAt > CONFIG.joinTimeoutMs) {
          log.warn('加入超时未检测到自身实体，重连');
          this._connectAndLoop();
        }
      }
      return;
    }

    if (!self) return;

    // 逃生优先级最高。
    if (shouldEscape(this.world)) {
      if (this.state !== State.ESCAPING) {
        log.warn(`HP ${self.hp} < ${CONFIG.escapeHp}，进入逃生`);
        this.state = State.ESCAPING;
        this._escapePhase = null; // 重置逃生子阶段，重新评估
      }
      this._escape();
      return;
    }

    // 恢复：重新加入后必须等待满血。
    if (this.state === State.WAITING_FOR_FULL_HP) {
      if (this.world.isFullHp()) {
        this.state = State.SCAVENGING;
        this.stateMsg = '满血，开始拾金中';
        log.info('已满血，开始拾金');
      } else {
        this.actions.stop();
        this.stateMsg = '等待满血';
        return;
      }
    }

    if (!this.world.isFullHp() && this.state !== State.SCAVENGING) {
      this.actions.stop();
      return;
    }

    // 反击判定：仅当确认攻击者。
    const attacker = this._confirmAttacker(now);
    if (attacker) {
      this._retaliate(attacker);
      return;
    }

    // 拾金。
    this._scavenge(now);
  }

  // 确认攻击者：优先用弹道/HP 下降关联。第一版保守——仅当 HP 刚下降且附近最近玩家构成威胁。
  _confirmAttacker(now) {
    if (this.world.hpEvents.length) {
      const last = this.world.hpEvents[this.world.hpEvents.length - 1];
      if (now - last.at < 3000) {
        const threat = nearestThreat(this.world, 20 * CONFIG.cmPerMeter);
        if (threat && distance(threat, last.self) < 200 * CONFIG.cmPerMeter) return threat;
      }
    }
    return null;
  }

  _retaliate(attacker) {
    this.state = State.RETALIATING;
    this.stateMsg = '反击中';
    const s = this.world.self;
    if (this.actions.setVelocity(0, 0) !== false) {
      // 攻击者仍在射程内则开火。
      if (distance(s, attacker) <= 150 * CONFIG.cmPerMeter) {
        this.actions.shoot(attacker.x, attacker.y, s.x, s.y);
      }
    }
    // 攻击者消失/离开射程即停止（tick 会重新判定）。
  }

  _scavenge(now) {
    const s = this.world.self;
    if (!s || s.hp < CONFIG.escapeHp) return; // 逃生在 _tick 已处理

    if (this._target && !this._targetStillValid(now)) this._target = null;

    const pick = chooseCoin(this.world);
    if (!pick) {
      // 没有目标：停止并等待；也可考虑往金币密度高的区域走，但第一版保守不做。
      this._target = null;
      this.state = State.SCAVENGING;
      this.stateMsg = '无目标金币';
      this.actions.stop();
      return;
    }

    const coin = pick.coin;
    this._target = coin;
    this.state = State.SCAVENGING;

    if (pick.distance <= CONFIG.pickupRadiusM * CONFIG.cmPerMeter) {
      this.actions.stop();
      this.stateMsg = `拾取金币 @(${Math.round(coin.x)},${Math.round(coin.y)})`;
      return;
    }

    // 速度命令向目标移动。
    const d = directionTo(s, coin);
    this.actions.setVelocity(d.dx, d.dy);
    this.stateMsg = `前往金币 D=${Math.round(pick.distance)}m @(${Math.round(coin.x)},${Math.round(coin.y)})`;
  }

  _targetStillValid(now) {
    if (!this._target) return false;
    // 目标需仍是当前可见金币。
    for (const c of this.world.coinDrops.values()) {
      if (c.id !== undefined && c.id === this._target.id) return true;
      if (c.x === this._target.x && c.y === this._target.y) return true;
    }
    return false;
  }

  _escape() {
    // 逃生采用多轮尝试：先尽力传送，失败/无目标/超时则离开。
    const s = this.world.self;
    if (!s) return;
    const now = Date.now();

    // 传送仍在途（已发出且等待回执），不再重复发送。
    if (this._escapePhase === 'teleporting') {
      // 等待传送回执定义在 setTimeout/事件处理；这里只是兜底。
      return;
    }

    const target = CONFIG.safeTeleport;
    // 仅当已配置安全坐标且 1h/1d 体力充足才传送。
    if (target && this.world.canTeleport()) {
      this.actions.stop();
      this.stateMsg = '逃生：尝试传送';
      const ok = this.actions.teleport(target[0], target[1]);
      if (ok) {
        this._escapePhase = 'teleporting';
        this.stateMsg = '逃生：传送已发送，等待回执';
        // 若超时未回执，则离开。
        setTimeout(() => {
          if (this._escapePhase === 'teleporting') this._leaveAndCooldown('传送超时');
        }, CONFIG.teleportTimeoutMs ?? 5000);
        return;
      }
    }

    // 无可传送目标或体力不足：直接离开。
    this._leaveAndCooldown(target ? '传送体力不足' : '未配置安全传送坐标');
  }

  // 供 WS 回执调用：teleport_ok 已成功脱离 -> 回等待满血；teleport_failed -> 快速离开。
  handleTeleportAck(ok, error) {
    if (this._escapePhase !== 'teleporting') return;
    this._escapePhase = ok ? 'teleported' : 'failed';
    if (ok) {
      clearTimeout(this._teleportTimer);
      log.info('传送成功，等待满血恢复');
      this.state = State.WAITING_FOR_FULL_HP;
      this.stateMsg = '逃生成功：等待恢复';
    } else {
      log.warn('传送失败：' + (error || '未知') + '，离开');
      this._leaveAndCooldown('传送失败');
    }
  }

  _leaveAndCooldown(reason) {
    log.warn(`离开游戏（${reason || '逃生'}）并进入 ${CONFIG.offlineCooldownSec}s 离线冷却`);
    this._escapePhase = null;
    clearTimeout(this._teleportTimer);
    this._offline();
    markOfflineCooldown(CONFIG.offlineCooldownSec);
    this.state = State.OFFLINE_COOLDOWN;
    this._connectAndLoop();
  }

  async _offline() {
    try {
      const { api } = await import('./comms.js');
      await api(`/leave?user_id=${encodeURIComponent(this.session.userId)}&token=${encodeURIComponent(this.session.token)}`);
      log.info('已发送 leave');
    } catch (err) {
      log.warn('leave 请求失败（将仍按冷却处理）:', err.message);
    }
  }
}

// ---------------- CLI ----------------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--auth')) {
    const { authorize } = await import('./auth.js');
    const s = await authorize();
    log.info(`授权完成：user_id=${s.userId}，凭据已本地保存。现在可运行 npm start`);
    return;
  }
  if (args.includes('--observe')) {
    CONFIG.observeOnly = true;
    log.info('观察模式：只接收状态，不发送任何游戏动作');
  }
  const bot = new Bot();
  await bot.start();
}

// 防止进程空闲退出。
process.on('unhandledRejection', (err) => log.error('未处理拒绝:', err?.message));
process.on('SIGINT', () => {
  log.info('收到中断，退出');
  process.exit(0);
});

if (process.argv[1] && import.meta.url.includes('index.js')) {
  const errorColor = '\x1b[31m';
  const reset = '\x1b[0m';
  main().catch((err) => {
    console.error(`${errorColor}[fatal] ${err?.message || err}${reset}`);
    process.exit(1);
  });
}