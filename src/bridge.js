// 桥接服务器：替代原来的直连 WebSocket 传输层。
//
// 为什么需要它：Cloudflare 按 TLS 指纹拦截了 Node 原生 WS 客户端(持续 502)，
// 但浏览器自己的连接是通的。所以让浏览器(油猴脚本)持有真正的游戏连接，
// Node 只做决策大脑，两者通过本机 WebSocket 通信。
//
// 数据流：
//   游戏服务器 <--(浏览器真实连接)--> 油猴脚本 <--(ws://127.0.0.1:8787)--> 本模块 --> 状态机
//
// 协议(与油猴脚本约定)：
//   油猴 -> Node: { kind:'game', msg:{...} }   # 游戏原始消息(snapshot/pos/回执)
//                 { kind:'hello', userId }     # 握手，告知自身 user_id
//   Node -> 油猴: { kind:'cmd', cmd:'vel 1 0' } # 要用游戏原生连接发送的命令

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

export const BRIDGE_PORT = Number(process.env.BOT_BRIDGE_PORT || 8787);
export const SCRIPT_PORT = Number(process.env.BOT_SCRIPT_PORT || 8790);

const __dirname = dirname(fileURLToPath(import.meta.url));

export class BridgeServer {
  constructor({ onMessage, onHello, onDisconnect, port = BRIDGE_PORT } = {}) {
    this.onMessage = onMessage;
    this.onHello = onHello;
    this.onDisconnect = onDisconnect;
    this.port = port;
    this.wss = null;
    this.client = null; // 当前连接的油猴脚本
    this.lastSnapshot = null; // 最近一次游戏 snapshot 缓存，供 /snapshot 查询
  }

  start() {
    // 只监听本机回环地址，不对外暴露。
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });

    // 额外提供一个 HTTP 端点，把浏览器桥接脚本的内容吐出来。
    // 用途：控制台只需粘贴一行 fetch，不必手动复制整段长脚本（避免粘贴被破坏/编码问题）。
    const scriptPath = join(__dirname, '..', 'userscript', 'console-bridge.js');
    const probePath = join(__dirname, '..', 'userscript', 'probe-units.user.js');
    this.http = createServer((req, res) => {
      // 允许任意源的浏览器跨域拉取脚本(仅本机回环，无安全风险)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/bridge.js') {
        try {
          const js = readFileSync(scriptPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
          res.end(js);
        } catch (err) {
          res.writeHead(500);
          res.end('read script failed: ' + err.message);
        }
      } else if (req.url === '/probe.js') {
        try {
          const js = readFileSync(probePath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
          res.end(js);
        } catch (err) {
          res.writeHead(500);
          res.end('read probe failed: ' + err.message);
        }
      } else if (req.url === '/snapshot') {
        // 返回最近 snapshot 的坐标分析，供浏览器探测坐标单位。
        // 直接从 Node 缓存取，不需要浏览器再挂 send 钩子（避免与桥接冲突）。
        const snap = this.lastSnapshot;
        if (!snap) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, haveData: false }));
          return;
        }
        const me = (snap.entities || []).find((e) => Number(e.user_id) === this.clientUserId);
        const out = {
          ok: true,
          haveData: true,
          me: me ? { user_id: me.user_id, x: me.x, y: me.y, hp: me.hp, max_hp: me.max_hp } : null,
          coin0: snap.coin_drops?.[0] ?? null,
          coinDeltas: (snap.coin_drops || []).map((c) => Math.round(Math.hypot(c.x - (me?.x ?? 0), c.y - (me?.y ?? 0)))).sort((a, b) => a - b).slice(0, 8),
          playerDeltas: (snap.entities || []).filter((e) => Number(e.user_id) !== this.clientUserId)
            .map((e) => Math.round(Math.hypot(e.x - (me?.x ?? 0), e.y - (me?.y ?? 0)))).sort((a, b) => a - b).slice(0, 8),
        };
        const pd = out.playerDeltas;
        if (pd.length) {
          const maxD = pd[pd.length - 1];
          out.maxPlayerDelta = maxD;
          out.unitsPerMeter = (maxD / 500).toFixed(2);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    this.http.listen(SCRIPT_PORT, '127.0.0.1', () => {
      log.info(`桥接脚本端点 http://127.0.0.1:${SCRIPT_PORT}/bridge.js —— 控制台一行 fetch 即可加载`);
    });

    this.wss.on('listening', () => {
      log.info(`桥接服务已启动 ws://127.0.0.1:${this.port} —— 等待浏览器油猴脚本接入…`);
    });

    this.wss.on('connection', (sock) => {
      if (this.client && this.client.readyState === 1) {
        log.warn('已有油猴脚本在连接，拒绝重复接入');
        sock.close();
        return;
      }
      this.client = sock;
      log.info('油猴脚本已接入');

      sock.on('message', (raw) => {
        let envelope;
        try {
          envelope = JSON.parse(raw.toString('utf8'));
        } catch {
          log.warn('桥接消息不是合法 JSON，已忽略');
          return;
        }
        if (envelope.kind === 'game' && envelope.msg) {
          // 缓存最近的 snapshot，供 HTTP /snapshot 查询原始坐标
          if (envelope.msg.type === 'snapshot') this.lastSnapshot = envelope.msg;
          this.onMessage?.(envelope.msg);
        } else if (envelope.kind === 'hello') {
          this.clientUserId = Number(envelope.userId);
          log.info(`油猴握手：user_id=${this.clientUserId}`);
          this.onHello?.(this.clientUserId);
        }
      });

      sock.on('close', () => {
        log.warn('油猴脚本已断开');
        if (this.client === sock) this.client = null;
        this.onDisconnect?.();
      });

      sock.on('error', (err) => log.error('桥接连接错误:', err.message));
    });

    this.wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`端口 ${this.port} 已被占用 —— 可能已有一个 bot 在运行`);
      } else {
        log.error('桥接服务错误:', err.message);
      }
    });
  }

  // 下发命令给油猴脚本，由它用游戏原生连接发送。
  send(cmd) {
    if (this.client?.readyState !== 1) return false;
    this.client.send(JSON.stringify({ kind: 'cmd', cmd }));
    return true;
  }

  isConnected() {
    return this.client?.readyState === 1;
  }

  close() {
    this.client?.close();
    this.wss?.close();
    this.http?.close();
  }
}