// ============================================================
// 囤囤鼠 WS 桥接（控制台版 v2 —— 支持自动下线/重新加入）
//
// 用法：游戏页 F12 -> Console -> 先手打 allow pasting 回车 -> 粘贴本文件全部内容
//
// v2 相比 v1 的关键改动：不再点游戏的「离开」按钮。
// 原因：那个按钮会清掉 localStorage 里的登录令牌(tmpGameSessionToken)，
// 令牌一没，重新加入就必须走 LinuxDO OAuth 跳转，页面跳走 -> 本脚本被销毁 -> 需手动重粘。
// 改为直接调 /leave 接口：退出可见实体层的效果一样，但登录态保留，可自动重新加入。
//
// 冷却期如何保持离线：游戏自己的 scheduleReconnect 每 1200ms 无限重试(已验证)，
// 所以冷却期内把游戏的重连指向一个立刻失败的地址，让它空转；
// Node 冷却结束发来 __rejoin 时解除封锁，游戏下一次重试即连上。
// 这样重连始终由【游戏自己】完成，画面渲染照常工作。
// ============================================================

(() => {
  'use strict';
  if (window.__bridgeLoaded) {
    console.warn('[bridge] 已加载过，请先刷新页面再粘贴');
    return;
  }
  window.__bridgeLoaded = true;

  const BRIDGE_URL = 'ws://127.0.0.1:8787';
  // 冷却期把游戏重连指向这里：会立刻失败，触发游戏自己的退避重试
  const DEAD_URL = 'ws://127.0.0.1:1/blocked';

  const T = '%c[bridge]';
  const OK = 'color:#34d399;font-weight:bold';
  const W = 'color:#fbbf24;font-weight:bold';
  const E = 'color:#f87171;font-weight:bold';

  const NativeWS = window.WebSocket;
  const rawSend = NativeWS.prototype.__bridgeRawSend || NativeWS.prototype.send;
  NativeWS.prototype.__bridgeRawSend = rawSend;

  const S = {
    game: null,      // 游戏的 WS
    bridge: null,    // 到 Node 的 WS
    selfId: 0,
    token: '',       // 从 WS URL 上取，用于直接调 /leave
    blocked: false,  // 冷却期封锁游戏重连
    fwd: 0,
    exec: 0,
    retry: 0,
  };

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
  // 实测：服务器不认 fetch('/leave') 单独调用，必须走完整客户端流程(点"离开"按钮，
  // 它内部置 manualDisconnect=true + 关连接 + 清 localStorage，服务器才真正下线)。
  // 但按钮会清 localStorage 令牌，所以：
  //   1) 点按钮前先保存令牌(在 S.token 内存里，不会丢)
  //   2) 点按钮
  //   3) 立刻把令牌写回 localStorage —— 供冷却结束后刷新页面重连用
  async function doLeave() {
    S.blocked = true;   // 先封锁，避免游戏立刻把我们拉回实体层
    if (!S.selfId || !S.token) {
      console.warn(T, E, '缺少 user_id/token');
      return;
    }
    console.log(T, W, `doLeave: selfId=${S.selfId} tokenLen=${(S.token||'').length}`);
    // 顺序很关键：必须【先点按钮、再写回令牌】。
    // 先写回再点按钮的话，按钮触发的游戏 leave() 会 removeItem 把我们刚写的令牌清掉。
    const btn = document.getElementById('leaveBtn');
    if (btn) {
      btn.click();
      console.log(T, W, '已点击「离开」按钮，服务器下线中');
    } else {
      console.warn(T, E, '找不到「离开」按钮');
    }
    // 等游戏 leave() 清完 localStorage 后，再把令牌写回去供刷新重连用。
    // 游戏 leave() 内部 await api('/leave') 是异步的，removeItem 可能在 await 之后才执行，
    // 所以多写几次、把时间拉开，确保最后一次写回是"最终状态"。
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
    // 断开连接，保持离线(游戏不会再自连，manualDisconnect=true)
    if (S.game && S.game.readyState <= 1) S.game.close();
  }

  // 冷却结束：刷新页面，让游戏重新初始化。
  // 刷新后 manualDisconnect 复位为 false，游戏从 localStorage 读令牌自动重连。
  function doRejoin() {
    S.blocked = false;
    console.log(T, OK, '冷却结束 —— 刷新页面，游戏将用已保存的令牌自动重连');
    setTimeout(() => location.reload(), 500);
  }

  // ---------- 连接 Node ----------
  function connectBridge() {
    let ws;
    try {
      ws = new NativeWS(BRIDGE_URL);
    } catch (err) {
      console.warn(T, E, '连不上 Node:', err.message);
      return retryBridge();
    }
    S.bridge = ws;

    ws.addEventListener('open', () => {
      S.retry = 0;
      console.log(T, OK, '✅ Node 已连接');
      if (S.selfId) ws.send(JSON.stringify({ kind: 'hello', userId: S.selfId }));
    });

    ws.addEventListener('message', (ev) => {
      let en;
      try { en = JSON.parse(ev.data); } catch { return; }
      if (en.kind !== 'cmd') return;

      if (en.cmd === '__leave') return void doLeave();
      if (en.cmd === '__rejoin') return void doRejoin();

      // 普通游戏命令：用游戏原生连接发送
      if (S.game?.readyState === 1) {
        rawSend.call(S.game, en.cmd);
        S.exec++;
      }
    });

    ws.addEventListener('close', () => {
      console.warn(T, W, 'Node 连接断开');
      S.bridge = null;
      retryBridge();
    });
    ws.addEventListener('error', () => { /* close 会紧随其后 */ });
  }

  function retryBridge() {
    const d = Math.min(1000 * 2 ** S.retry, 15000);
    S.retry = Math.min(S.retry + 1, 4);
    setTimeout(connectBridge, d);
  }

  // ---------- 接管游戏连接 ----------
  function attach(ws) {
    if (!ws || S.game === ws) return;
    S.game = ws;
    try {
      const p = new URL(ws.url).searchParams;
      S.selfId = Number(p.get('user_id')) || S.selfId;
      S.token = p.get('token') || S.token;   // 留着调 /leave 用
    } catch { /* 忽略解析失败 */ }
    console.log(T, OK, `✅ 已接管游戏连接 user_id=${S.selfId}`);

    if (S.bridge?.readyState === 1) {
      S.bridge.send(JSON.stringify({ kind: 'hello', userId: S.selfId }));
    }

    // 只旁听，不消费 —— 游戏自己照常处理消息、照常渲染
    ws.addEventListener('message', (ev) => {
      inflate(ev.data)
        .then((text) => {
          if (S.bridge?.readyState !== 1) return;
          S.bridge.send(JSON.stringify({ kind: 'game', msg: JSON.parse(text) }));
          S.fwd++;
        })
        .catch((err) => console.warn(T, W, '解析失败:', err.message));
    });

    ws.addEventListener('close', () => {
      if (S.game === ws) S.game = null;
    });
  }

  // 替换构造器：冷却期把游戏的重连引到失败地址，让它空转重试
  class Guarded extends NativeWS {
    constructor(url, protocols) {
      const u = String(url);
      const isGame = u.includes('/ws?');
      if (isGame && S.blocked) {
        super(DEAD_URL);
        return;
      }
      super(url, protocols);
      if (isGame) attach(this);
    }
  }
  // 保留静态常量(CONNECTING/OPEN/...)，个别代码会用到
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { Guarded[k] = NativeWS[k]; } catch { /* 只读则忽略 */ }
  }
  window.WebSocket = Guarded;

  // 兜底：脚本注入晚于连接建立时，靠 send 抓住已经活着的连接
  NativeWS.prototype.send = function (data) {
    if (typeof this.url === 'string' && this.url.includes('/ws?')) attach(this);
    return rawSend.call(this, data);
  };
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v instanceof NativeWS && typeof v.url === 'string' && v.url.includes('/ws?')) {
        attach(v);
        break;
      }
    } catch { /* 某些属性访问会抛，忽略 */ }
  }

  // ---------- 控制台辅助 ----------
  window.__bridge = {
    get status() {
      return {
        游戏连接: S.game?.readyState === 1,
        Node连接: S.bridge?.readyState === 1,
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

  connectBridge();
  console.log(T, OK, '注入完成（v2：支持自动下线/重新加入）');
  console.log(T, S.game ? OK : W, S.game
    ? '游戏连接已抓到'
    : '⚠️ 还没抓到游戏连接 —— 请点游戏画面，按一下 W 或 D');
})();
