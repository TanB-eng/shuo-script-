// ==UserScript==
// @name         囤囤鼠 WS 桥接（自动下线/重连版 v2.3 - 无节流后台保活）
// @namespace    grasp-rat-bot
// @version      2.3.0
// @description  Worker桥接 + 静音音视频保活 + WebLock；配合无节流浏览器可长时间后台
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
    lastWorkerTick: 0,
    staleWarned: false,
  };

  // ---------- Web Worker 代码（内嵌 Blob） ----------
  // Worker 持有到 Node 的 WS，完全不受标签页节流。
  const WORKER_CODE = `
    var ws = null;
    var retry = 0;
    var selfId = 0;
    var bridgeUrl = 'ws://127.0.0.1:8787';
    var lastGameAt = 0;

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

    // Worker 定时器不受标签页节流；定期踢主线程，并上报桥接健康。
    setInterval(function() {
      postMessage({
        type: 'tick',
        t: Date.now(),
        bridgeOpen: !!(ws && ws.readyState === 1),
        lastGameAt: lastGameAt,
      });
    }, 5000);

    onmessage = function(ev) {
      var m = ev.data;
      if (m.type === 'hello') {
        selfId = m.userId;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'hello', userId: selfId }));
      } else if (m.type === 'game') {
        lastGameAt = Date.now();
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
      } else if (m.type === 'tick') {
        // 被 Worker 踢醒：维持主线程最低活跃，并在长时间无游戏消息时提示
        S.lastWorkerTick = m.t;
        if (m.lastGameAt && Date.now() - m.lastGameAt > 45000) {
          if (!S.staleWarned) {
            S.staleWarned = true;
            console.warn(T, W, '⚠️ 超过 45s 未收到游戏快照。正在自动保活/自愈；若仍无数据请改用「启动无节流浏览器.bat」');
          }
          tryAutoHeal('no-game-snapshot-45s');
        }
        if (m.lastGameAt && Date.now() - m.lastGameAt <= 20000) S.staleWarned = false;
        ensureKeepAlive();
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
    if (en.cmd === '__nudge') { ensureKeepAlive(); tryAutoHeal('node-nudge'); return; }

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

  // ---------- 后台保活（尽量无需切回标签页） ----------
  // 说明：普通浏览器后台会冻结主线程；仅靠脚本无法 100% 对抗。
  // 推荐配合根目录「启动无节流浏览器.bat」使用，可真正长期后台挂机。
  // 本段在普通浏览器里尽量拖延冻结：静音音视频 + WebLock + WakeLock + Worker 踢醒。
  let keepAudio = null;
  let keepVideo = null;
  let wakeLock = null;
  let lockHeld = false;
  let lastHealAt = 0;

  function ensureKeepAlive() {
    // 1) 静音 AudioContext
    try {
      if (!keepAudio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          keepAudio = new AC();
          const osc = keepAudio.createOscillator();
          const gain = keepAudio.createGain();
          gain.gain.value = 0.00001;
          osc.frequency.value = 40;
          osc.connect(gain);
          gain.connect(keepAudio.destination);
          osc.start();
        }
      }
      if (keepAudio && keepAudio.state === 'suspended') keepAudio.resume().catch(() => {});
    } catch { /* 忽略 */ }

    // 2) 静音循环 video（比纯 Audio 更能阻止标签深度休眠）
    try {
      if (!keepVideo) {
        keepVideo = document.createElement('video');
        keepVideo.setAttribute('playsinline', '');
        keepVideo.setAttribute('muted', '');
        keepVideo.muted = true;
        keepVideo.loop = true;
        keepVideo.autoplay = true;
        keepVideo.playsInline = true;
        keepVideo.style.cssText = 'position:fixed;left:-99px;top:-99px;width:1px;height:1px;opacity:0;pointer-events:none;';
        // 极短 silent wav data uri
        keepVideo.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';
        document.documentElement.appendChild(keepVideo);
      }
      const p = keepVideo.play();
      if (p && p.catch) p.catch(() => {});
    } catch { /* 忽略 */ }

    // 3) Web Locks：占用一个永不释放的锁，降低被丢弃概率
    try {
      if (!lockHeld && navigator.locks?.request) {
        lockHeld = true;
        navigator.locks.request('grasp-rat-bot-keepalive', { mode: 'shared' }, () => new Promise(() => {})).catch(() => { lockHeld = false; });
      }
    } catch { lockHeld = false; }

    // 4) Screen Wake Lock（笔记本合盖前有用；后台标签不一定批准）
    if (!wakeLock && navigator.wakeLock?.request) {
      navigator.wakeLock.request('screen').then((lock) => {
        wakeLock = lock;
        lock.addEventListener('release', () => { wakeLock = null; });
      }).catch(() => {});
    }
  }

  // 卡住自愈：长时间无游戏消息时，尝试轻量恢复（不依赖你切回标签）
  function tryAutoHeal(reason) {
    const now = Date.now();
    if (now - lastHealAt < 60000) return; // 最多 60s 一次，避免刷屏
    lastHealAt = now;
    console.warn(T, W, '尝试自动恢复:', reason);
    ensureKeepAlive();
    try {
      // 轻推游戏连接：发一个无害 ping 风格流量无法直达服务器时，至少激活主线程处理队列
      if (S.game && S.game.readyState === 1) {
        // 不发送非法游戏命令；仅读取缓冲状态并触发微任务
        void S.game.bufferedAmount;
      }
      // 若完全没有游戏连接，尝试解除封锁并等待游戏自重连
      if (!S.game || S.game.readyState > 1) {
        S.blocked = false;
      }
    } catch { /* 忽略 */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.warn(T, W, '⚠️ 标签页进入后台 —— 已启用音视频保活。若需真正长期挂机，请用「启动无节流浏览器.bat」');
      ensureKeepAlive();
    } else {
      console.log(T, OK, '✅ 标签页已恢复前台');
      S.staleWarned = false;
      ensureKeepAlive();
    }
  });

  // 用户首次交互后启动保活（自动播放策略）
  const arm = () => { ensureKeepAlive(); window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
  window.addEventListener('pointerdown', arm, { once: true });
  window.addEventListener('keydown', arm, { once: true });
  // 页面已可见时尽早尝试
  if (document.visibilityState === 'visible') setTimeout(ensureKeepAlive, 0);

  console.log(T, OK, '注入完成（v2.3：Worker + 音视频保活 + 自愈）');
  console.log(T, S.game ? OK : W, S.game
    ? '游戏连接已抓到'
    : '⚠️ 还没抓到游戏连接 —— 请点游戏画面，按一下 W 或 D');
})();
