// 通信模块：HTTP API + WebSocket 连接、消息解析、断线重连。
// Node 端强制 compress= 空串以获取明文 JSON 帧（见 spec 通信模块）。

import WebSocket from 'ws';
import { CONFIG } from './config.js';
import { log } from './logger.js';

// ---------------- HTTP API ----------------
export async function api(path, { baseUrl = CONFIG.baseUrl } = {}) {
  const res = await fetch(baseUrl + path, { cache: 'no-store' });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------- WebSocket ----------------
export class WsClient {
  constructor({ userId, token, onMessage, onOpen, onClose, observeOnly = false } = {}) {
    this.userId = userId;
    this.token = token;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.observeOnly = observeOnly;
    this.ws = null;
    this.manualClose = false;
    this._retry = 0;
    this._reconnectTimer = null;
    this._cooling = false;
  }

  wsUrl() {
    const scheme = CONFIG.baseUrl.startsWith('https') ? 'wss://' : 'ws://';
    const host = CONFIG.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    // compress= 空串 => 服务器返回明文 JSON，Node 无需解压缩
    return `${scheme}${host}/ws?user_id=${encodeURIComponent(this.userId)}&token=${encodeURIComponent(this.token)}&compress=`;
  }

  connect() {
    this.manualClose = false;
    this._open();
  }

  _open() {
    if (this.manualClose) return;
    // 浏览器 WS 升级请求带 origin + 浏览器 UA；Node ws 默认不发。
    // WebSocket Origin 校验是防跨站劫持的标准手段，缺 origin 会被边缘层判为非浏览器拒连(502)。
    const origin = new URL(CONFIG.baseUrl).origin;
    const ws = new WebSocket(this.wsUrl(), {
      origin,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
      },
    });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.on('open', () => {
      this._retry = 0;
      log.info('WebSocket 在线');
      this.onOpen?.();
    });

    ws.on('message', async (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          log.warn('收到非 JSON 帧（可能是压缩帧，而 compress= 未生效）:', typeof text === 'string' && text.length > 8 ? text.slice(0, 8) : '[binary]');
          return; // 无法处理则忽略（不应出现，因 compress= 空串）
        }
        this.onMessage?.(msg);
      } catch (err) {
        log.error('消息处理异常:', err.message);
      }
    });

    ws.on('close', () => {
      log.warn('WebSocket 关闭');
      this.onClose?.();
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.error('WebSocket 错误:', err.message);
    });
  }

  // 有限退避重连：每轮 1s,2s,4s,8s,16s（retry 递增后回到 6→30s 封顶）。
  // 为防无限重试刷新服务器限流：每轮最多 RETRIES_PER_ROUND 次，之后**彻底安静**
  // COOL_PAUSE_MS（10 分钟）完全不碰服务器，再开始下一轮。这样既低频率又长期自动恢复。
  _scheduleReconnect() {
    if (this.manualClose) return;
    if (this._retry >= RETRIES_PER_ROUND) {
      this._retry = 0;
      this._cooling = true;
      log.warn(`已连续失败 ${RETRIES_PER_ROUND} 次，暂停 ${(COOL_PAUSE_MS / 60000).toFixed(0)} 分钟完全静默，避免触发/刷新限流`);
      this._reconnectTimer = setTimeout(() => {
        this._cooling = false;
        log.info('冷却暂停结束，恢复重连');
        this._reconnectTimer = setTimeout(() => this._open(), backoffMs(this._retry));
      }, COOL_PAUSE_MS);
      return;
    }
    const delay = backoffMs(this._retry);
    this._retry = Math.min(this._retry + 1, 6);
    log.info(`计划 ${(delay / 1000).toFixed(0)}s 后重连（第 ${this._retry} 次重试）`);
    this._reconnectTimer = setTimeout(() => this._open(), delay);
  }

  send(cmd) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(cmd);
      return true;
    }
    return false;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.manualClose = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

// 有限退避：1s,2s,4s,8s,16s 封顶 30s
export function backoffMs(retry) {
  const cap = [1000, 2000, 4000, 8000, 16000, 30000];
  return cap[Math.min(retry, cap.length - 1)];
}

// 每轮最大重试次数；达到后进入长静默冷却
const RETRIES_PER_ROUND = 6;
// 长静默冷却时长：连败后的完全静默期（毫秒）
const COOL_PAUSE_MS = 10 * 60 * 1000;