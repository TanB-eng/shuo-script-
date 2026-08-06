// ==UserScript==
// @name         囤囤鼠 WS 桥接（自动下线/重连版 v2.1 - Worker防冻结）
// @namespace    grasp-rat-bot
// @version      2.1.0
// @description  Node 桥接连接移入 Web Worker，防止后台标签页冻结停止拾金
// @match        https://grasp-rat-game.h-e.top/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

// 解决后台标签页冻结问题：
// Chrome/Edge 对隐藏标签的 setTimeout 会限速到1次/秒，5分钟后1次/分钟。
// 将 Node 桥接的 WebSocket 放入 Web Worker：Worker 不受标签页节流，
// 网络I/O和定时器在后台与前台完全一致。
// 游戏那条WS留在主线程（需要DOM），两者通过postMessage通信。

(() => {
  'use strict';

  const BRIDGE_URL = 'ws://127.0.0.1:8787';
  const DEAD_URL = 'ws://127.0.0.1:1/blocked';

  const T = '%c[bridge]';
  const OK = 'color:#34d399;font-weight:bold';
  const W = 'color:#fbbf24;font-weight:bold';
  const E = 'color:#f87171;font-weight:bold';

  const NativeWS = window.WebSocket;
  const rawSend = NativeWS.prototype.__bridgeRawSend || NativeWS.prototype.send;
  NativeWS.prototype.__bridgeRawSend = rawSend;

  const S = {
    game: null,      // 游戏的 WS（主线程）
    worker: null,    // Web Worker（持有 Node 桥接 WS）
    selfId: 0,
    token: '',
    blocked: false,
    fwd: 0,
    exec: 0,
  };

  // ---------- Web Worker 代码（内嵌 Blob） ----------
  // Worker 持有到 Node 的 WS，完全不受标签页节流。
  const WORKER_CODE = `
    var ws = null;
    var retry = 0;
    var selfId = 0;
    var bridgeUrl = 'ws://127.0.0.1:8787';

    function connect() {
      try { ws = new WebSocket(bridgeUrl); }
      catch(e) { scheduleRetry(); return; }

      ws.onopen = function() {
        retry = 0;
        postMessage({ type: 'open' });
        if (selfId) ws.send(JSON.stringify({ kind: 'hello', userId: selfId }));
      };
      ws.onmessage = function(ev) {
        postMessage({ type: 'cmd', data: ev.data });
      };
      ws.onclose = function() {
        postMessage({ type: 'close' });
        scheduleRetry();
      };
      ws.onerror = function() {};
    }

    function scheduleRetry() {
      var d = Math.min(1000 * Math.pow(2, retry), 15000);
      retry = Math.min(retry + 1, 4);
      setTimeout(connect, d);
    }

    onmessage = function(ev) {
      var m = ev.data;
      if (m.type === 'hello') {
        selfId = m.userId;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'hello', userId: selfId }));
      } else if (m.type === 'game') {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'game', msg: m.msg }));
      } else if (m.type === 'cmd_send') {
        // 从主线程转发命令给 Node（如 __leave 的反向确认，一般不用）
        if (ws && ws.readyState === 1) ws.send(m.data);
      }
    };

    connect();
  `;

  function createWorker() {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'open') {
        console.log(T, OK, '✅ Node 已连接（Worker）');
        if (S.selfId) worker.postMessage({ type: 'hello', userId: S.selfId });
      } else if (m.type === 'close') {
        console.warn(T, W, 'Node 连接断开（Worker 自动重连中）');
      } else if (m.type === 'cmd') {
        handleNodeCmd(m.data);
      }
    };

    worker.onerror = (e) => console.warn(T, E, 'Worker 错误:', e.message);
    S.worker = worker;
    return worker;
  }

  function handleNodeCmd(raw) {
    let en;
    try { en = JSON.parse(raw); } catch { return; }
    if (en.kind !== 'cmd') return;

    if (en.cmd === '__leave') return void doLeave();
    if (en.cmd === '__rejoin') return void doRejoin();

    // 普通游戏命令：用游戏原生连接发送（主线程，不受节流影响因为是响应事件）
    if (S.game?.readyState === 1) {
      rawSend.call(S.game, en.cmd);
      S.exec++;
    }
  }

  function workerSend(data) {
    S.worker?.postMessage({ type: 'cmd_send', data });
  }

  // Worker 是否已连接（主线程侧没有直接状态，用 hello 回声判断）
  let workerConnected = false;
  const _origOnMsg = null;

  // ---------- 与游戏客户端一致的解压 ----------
  async function inflate(data) {
    if (typeof data === 'string') return data;
    const buf = data instanceof Blob ? await data.arrayBuffer() : data;
    const b = new Uint8Array(buf);
    if (b.length < 5 || b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x5a || b[3] !== 0x31) {
      return new TextDecoder().decode(b);
    }
    const f = b[4] === 1 ? 'gzip' : b[4] === 2 ? 'deflate' : b[4] === 3 ? 'zstd' : '';
    if (!f) throw new Error('未知压缩 algId=' + b[4]);
    const st = new Blob([b.slice(5)]).stream().pipeThrough(new DecompressionStream(f));
    return await new Response(st).text();
  }

  // ---------- 退出可见实体层 ----------
  async function doLeave() {
    S.blocked = true;
    console.log(T, W, `doLeave: selfId=${S.selfId} tokenLen=${(S.token || '').length}`);
    const btn = document.getElementById('leaveBtn');
    if (btn) {
      btn.click();
      console.log(T, W, '已点击「离开」按钮，服务器下线中');
    } else {
      console.warn(T, E, '找不到「离开」按钮');
    }
    if (S.selfId && S.token) {
      [300, 1200, 3000].forEach((ms) => {
        setTimeout(() => {
          try {
            localStorage.setItem('tmpGameUserId', String(S.selfId));
            localStorage.setItem('tmpGameSessionToken', S.token);
            console.log(T, OK, `写回令牌(第 ${ms}ms 次)`);
          } catch (err) {
            console.warn(T, E, '写回令牌失败:', err.message);
          }
        }, ms);
      });
    } else {
      console.warn(T, E, '无 token，无法自动重连（本次下线后需手动登录）');
    }
    if (S.game && S.game.readyState <= 1) S.game.close();
  }

  function doRejoin() {
    S.blocked = false;
    console.log(T, OK, '冷却结束 —— 刷新页面，游戏将用已保存的令牌自动重连');
    setTimeout(() => location.reload(), 500);
  }

  // ---------- 接管游戏连接 ----------
  function attach(ws) {
    if (!ws || S.game === ws) return;
    S.game = ws;
    try {
      const p = new URL(ws.url).searchParams;
      S.selfId = Number(p.get('user_id')) || S.selfId;
      S.token = p.get('token') || S.token;
    } catch { /* 忽略 */ }
    console.log(T, OK, `✅ 已接管游戏连接 user_id=${S.selfId}`);

    // 通知 Worker 发送 hello
    if (S.selfId) S.worker?.postMessage({ type: 'hello', userId: S.selfId });

    // 只旁听，不消费 —— 游戏自己照常处理消息、照常渲染
    // 注意：这里转发给 Worker（而非直接发 bridge WS），Worker 不受节流
    ws.addEventListener('message', (ev) => {
      inflate(ev.data)
        .then((text) => {
          const msg = JSON.parse(text);
          S.worker?.postMessage({ type: 'game', msg });
          S.fwd++;
        })
        .catch((err) => console.warn(T, W, '解析失败:', err.message));
    });

    ws.addEventListener('close', () => {
      if (S.game === ws) S.game = null;
    });
  }

  // 替换构造器：冷却期把游戏重连引到失败地址
  class Guarded extends NativeWS {
    constructor(url, protocols) {
      const u = String(url);
      const isGame = u.includes('/ws?');
      if (isGame && S.blocked) { super(DEAD_URL); return; }
      super(url, protocols);
      if (isGame) attach(this);
    }
  }
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { Guarded[k] = NativeWS[k]; } catch { /* 只读则忽略 */ }
  }
  window.WebSocket = Guarded;

  // 兜底：脚本注入晚于连接建立时
  NativeWS.prototype.send = function (data) {
    if (typeof this.url === 'string' && this.url.includes('/ws?')) attach(this);
    return rawSend.call(this, data);
  };
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v instanceof NativeWS && typeof v.url === 'string' && v.url.includes('/ws?')) { attach(v); break; }
    } catch { /* 忽略 */ }
  }

  // ---------- 控制台辅助 ----------
  window.__bridge = {
    get status() {
      return {
        游戏连接: S.game?.readyState === 1,
        Node连接: '通过Worker(后台不冻结)',
        自身ID: S.selfId,
        令牌已捕获: !!S.token,
        令牌长度: (S.token || '').length,
        冷却封锁中: S.blocked,
        已转发: S.fwd,
        已执行: S.exec,
      };
    },
    leave: doLeave,
    rejoin: doRejoin,
  };

  // 启动 Worker
  createWorker();

  // 页面可见性提示（后台不冻结，但游戏WS的message事件仍在主线程）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.warn(T, W, '⚠️ 标签页进入后台 —— Node桥接(Worker)不受影响，游戏WS在主线程可能有延迟');
    } else {
      console.log(T, OK, '✅ 标签页已恢复前台');
    }
  });

  console.log(T, OK, '注入完成（v2.1：Web Worker 防冻结）');
  console.log(T, S.game ? OK : W, S.game
    ? '游戏连接已抓到'
    : '⚠️ 还没抓到游戏连接 —— 请点游戏画面，按一下 W 或 D');
})();
