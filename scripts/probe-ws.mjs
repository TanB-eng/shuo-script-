// 单次探测：尝试建立一次 WebSocket 连接，判断边缘层(TLS指纹/网关)是否放行。
// 退出码：0=可连接（封锁解除），1=仍被拦，2=其他错误。
// 只建立一次短连接即断开，不发送任何游戏动作（只读探测）。
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { userId, token } = JSON.parse(readFileSync(join(root, '.data', 'session.json'), 'utf8'));
const base = process.env.BOT_BASE_URL || 'https://grasp-rat-game.h-e.top';
const scheme = base.startsWith('https') ? 'wss://' : 'ws://';
const host = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
const url = `${scheme}${host}/ws?user_id=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}&compress=`;

const origin = new URL(base).origin;
const ws = new WebSocket(url, {
  origin,
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
});
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); process.exit(1); }, 8000);

ws.on('open', () => {
  clearTimeout(timer);
  console.log('OK: WS 可连接');
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  clearTimeout(timer);
  console.log('FAIL:', e.message);
  process.exit(1);
});