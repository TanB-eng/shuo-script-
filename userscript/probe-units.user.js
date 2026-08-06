// 坐标单位探测脚本 —— 从游戏 snapshot 读取自身/金币/玩家的原始坐标，
// 计算"视野内玩家的最大坐标差 ÷ 500m"得到每米的坐标单位数。
// 用法：游戏页控制台一行 fetch 加载（同 console-bridge）。
// 需要先有桥接脚本在跑（它已接管了游戏连接），本脚本直接复用 window.__bridge 的内部状态，
// 所以【不会】再改 WebSocket.prototype.send，不与桥接打架。

(() => {
  'use strict';

  // 桥接脚本把捕获到的游戏连接存到哪里？
  // 如果桥接脚本在跑，会通过 prototype.send 挂监听；但这里更简单的方式是：
  // 直接向 Node 要一份"最近 snapshot"的原始字段。
  // 但 Node 那边我们没有转发原始快照的缓存接口，所以退而求其次：
  // 自己抓一条游戏连接（桥接已改过 prototype.send，此处只挂 listener，不冲突）。

  let ws = null;
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.indexOf('/ws?') > 0) {
        ws = v;
        break;
      }
    } catch (e) { /* 忽略 */ }
  }

  // 桥接脚本会替换 window.WebSocket 成 Hooked 类，扫 window 找不到真实实例（在闭包里）。
  // 所以靠已注入的 __bridge 去取：桥接脚本里 S.game 存的就是游戏连接。
  // 但 __bridge 没暴露原始 ws，因此这里改为：让用户点一下游戏画面触发一次 send，
  // 我们靠一个临时 send 钩子捕获 —— 与桥接共用同一个底层，且只挂一次后立刻摘除。
  const NS = WebSocket.prototype;
  const O = NS.__o || NS.send; // 桥接已存原始 send 在 __o
  NS.__o = O;

  let done = false;
  const tmpSend = function (d) {
    if (!done && typeof this.url === 'string' && this.url.indexOf('/ws?') > 0) {
      done = true;
      NS.send = O; // 摘除临时钩子
      probe(this);
    }
    return O.call(this, d);
  };
  NS.send = tmpSend;

  function probe(ws) {
    const once = async (ev) => {
      const b = new Uint8Array(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data);
      let txt;
      if (b[0] === 71 && b[1] === 82 && b[2] === 90 && b[3] === 49) {
        const f = b[4] === 1 ? 'gzip' : b[4] === 2 ? 'deflate' : 'zstd';
        txt = await new Response(new Blob([b.slice(5)]).stream().pipeThrough(new DecompressionStream(f))).text();
      } else {
        txt = new TextDecoder().decode(b);
      }
      const m = JSON.parse(txt);
      if (m.type !== 'snapshot') return;
      ws.removeEventListener('message', once);
      const uid = Number(new URL(ws.url).searchParams.get('user_id'));
      let me = null;
      for (const e of (m.entities || [])) if (Number(e.user_id) === uid) { me = e; break; }
      if (!me) { console.warn('[probe] 自身不在 snapshot 中'); return; }

      console.log('[probe] SELF =', JSON.stringify({ x: me.x, y: me.y, hp: me.hp, max_hp: me.max_hp }));
      console.log('[probe] COIN_SAMPLE =', JSON.stringify(m.coin_drops && m.coin_drops[0]));

      const coinD = (m.coin_drops || []).map(c => Math.round(Math.hypot(c.x - me.x, c.y - me.y))).sort((a, b) => a - b);
      console.log('[probe] COIN_DELTAS(近8) =', coinD.slice(0, 8).join(', '));

      const pD = (m.entities || []).filter(e => Number(e.user_id) !== uid)
        .map(e => Math.round(Math.hypot(e.x - me.x, e.y - me.y))).sort((a, b) => a - b);
      console.log('[probe] PLAYER_DELTAS(近5) =', pD.slice(0, 5).join(', '));
      if (pD.length) {
        const maxD = pD[pD.length - 1];
        console.log('[probe] MAX_PLAYER_DELTA =', maxD, '  UNITS_PER_METER ≈', (maxD / 500).toFixed(2));
        console.log('[probe] 若 UNITS_PER_METER ≈ 100 → 坐标单位是厘米(cm)；≈ 1 → 是米');
      } else {
        console.log('[probe] 视野内没有其他玩家，无法用玩家估算。请靠近一个金币后用目测对比 COIN_DELTAS 与屏幕距离。');
      }
      console.log('[probe] 探测完成。把以上 [probe] 输出发给我。');
    };
    ws.addEventListener('message', once);
    console.log('[probe] 已挂监听，等下一个 snapshot（约1秒）…');
  }

  console.log('[probe] 坐标单位探测已加载。请点一下游戏画面并按下 W 或 D 触发一次移动指令，我就能捕获连接并解析。');
  console.log('[probe] 注意：如果 3 秒内没反应，就再按一下 W。');
})();
