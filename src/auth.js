// 认证模块：首次通过正常浏览器完成 LinuxDO 授权，将会话凭据安全保存在本机。
// 会话失效时停止自动动作并要求重新授权。

import readline from 'node:readline';
import { createRequire } from 'node:module';
import { api } from './comms.js';
import { loadSession, saveSession } from './config.js';
import { log } from './logger.js';

const require = createRequire(import.meta.url);

// 尝试复用已保存的会话。
export function getStoredSession() {
  const s = loadSession();
  if (s && s.userId && s.token) return s;
  return null;
}

// 校验会话：探测网络可达即可；token 语义在 WS 连接后通过首个自身实体回显确认。
export async function validateSession(session) {
  try {
    await api('/minimap');
  } catch {
    log.warn('网络探测失败（minimap），将仍尝试连接 WebSocket 确认会话）');
  }
  return session;
}

// 交互式发起一次 LinuxDO 授权。
// 服务器 /auth/linuxdo/start 返回 auth_url，浏览器打开完成授权后，回调会落到
// 游戏站点根路径并携带 ?login=ok&user_id=..&token=..。由于回调落在游戏站点而非
// 本机进程，首次授权采用「粘贴回调 URL」的一次性手动方式获取凭据。
export async function authorize({ openBrowser = true } = {}) {
  const data = await api('/auth/linuxdo/start');
  const authUrl = data.auth_url;
  if (!authUrl) throw new Error('服务器未返回 auth_url');

  log.info('请在浏览器中完成 LinuxDO 授权：');
  log.info(authUrl);
  if (openBrowser) {
    try {
      require('node:child_process').exec(`start "" "${authUrl}"`);
    } catch {
      log.warn('无法自动打开浏览器，请手动复制上面的链接');
    }
  }

  log.info('');
  log.info('授权完成后，浏览器地址栏会回到游戏站点并带查询参数。');
  log.info('请把该完整 URL 粘贴到此处并回车（形如 https://…/?login=ok&user_id=…&token=…）：');
  const fullUrl = await promptOnce();
  return extractSession(fullUrl);
}

// 从回调 URL / query 字符串提取 { userId, token } 并持久化。
export function extractSession(urlOrQuery) {
  const q = urlOrQuery.includes('?') ? urlOrQuery.split('?')[1] : urlOrQuery;
  const params = new URLSearchParams(q);
  if (params.get('login') !== 'ok') {
    throw new Error('未检测到 login=ok，授权可能未完成，请重试');
  }
  const userId = Number(params.get('user_id'));
  const token = params.get('token');
  if (!userId || !token) throw new Error('回调缺少 user_id 或 token');
  const session = { userId, token, obtainedAtEpochMs: Date.now() };
  saveSession(session);
  return session;
}

// 读一行 stdin（交互授权用）。
export function promptOnce() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}