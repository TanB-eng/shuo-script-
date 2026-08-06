// 动作模块：所有出站命令都走单一队列，遵守真实客户端观察到的频率限制。
// 命令均为明文空格分隔（见 spec 协议附录）。

import { log } from './logger.js';

// 真实客户端节流：vel 每 100ms 仲裁一次；shoot 受 0.1s/发烧区限制。
const VEL_THROTTLE_MS = 100;
const SHOOT_THROTTLE_MS = 100;

export class ActionQueue {
  constructor({ wsProvider, observeOnly = false } = {}) {
    this.wsProvider = wsProvider; // () => WebSocket | null
    this.observeOnly = observeOnly;
    this.lastVelSentAt = 0;
    this.lastShootSentAt = 0;
    this._lastVelSent = null; // 上次成功发送的 vel，避免重复
  }

  _ws() {
    return this.wsProvider();
  }

  _send(cmd, { throttled = false, lastAtKey = null, minInterval = 0 } = {}) {
    if (this.observeOnly) {
      log.trace(`[observe] 抑制发送: ${cmd}`);
      return false;
    }
    const ws = this._ws();
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      log.warn(`动作被抑制（ws 未开放）: ${cmd}`);
      return false;
    }
    if (throttled && lastAtKey) {
      const now = Date.now();
      if (now - this[lastAtKey] < minInterval) return false;
      this[lastAtKey] = now;
    }
    ws.send(cmd);
    log.debug(`<< ${cmd}`);
    return true;
  }

  // 设置速度方向。dx,dy ∈ [-1,1]。与真实客户端一致：100ms 节流 + 相同值去重。
  setVelocity(dx, dy) {
    const vel = `${clamp01(dx)} ${clamp01(dy)}`;
    if (vel === this._lastVelSent) return; // 未变化不重复发送
    const ok = this._send(`vel ${vel}`, { throttled: true, lastAtKey: 'lastVelSentAt', minInterval: VEL_THROTTLE_MS });
    if (ok) this._lastVelSent = vel;
    return ok;
  }

  stop() {
    if (this._lastVelSent === '0 0') return;
    const ok = this._send('vel 0 0');
    if (ok) this._lastVelSent = '0 0';
    return ok;
  }

  // 向世界坐标开火。startX/startY 为自身取整坐标。
  shoot(worldX, worldY, startX, startY) {
    return this._send(`shoot ${Math.round(worldX)} ${Math.round(worldY)} ${Math.round(startX)} ${Math.round(startY)}`, {
      throttled: true,
      lastAtKey: 'lastShootSentAt',
      minInterval: SHOOT_THROTTLE_MS,
    });
  }

  teleport(x, y) {
    return this._send(`tp ${Math.round(x)} ${Math.round(y)}`);
  }

  chat(text) {
    return this._send(`chat ${text}`);
  }

  reportChat(messageId) {
    return this._send(`report_chat ${Number(messageId)}`);
  }
}

function clamp01(v) {
  return Math.max(-1, Math.min(1, Number(v) || 0));
}