import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeBot } from '../src/bot-bridge.js';
import { CONFIG } from '../src/config.js';
import { chooseAggroTarget, getPlayerGold, strafeDirection, leadPoint } from '../src/strategy.js';
import { log } from '../src/logger.js';

// 构造一个观察模式(不发真实指令)的桥接 bot，并用 stub 记录 emit 调用。
// 覆盖 shoot/setVelocity 以绕过 100ms 节流，专注测"打谁/是否追击"的目标逻辑。
function seedBotBridge() {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  const calls = { vel: [], shoot: [], leave: false };
  bot.emit = (cmd) => {
    if (cmd.startsWith('vel')) calls.vel.push(cmd);
    else if (cmd.startsWith('shoot')) calls.shoot.push(cmd);
    else if (cmd.startsWith('__leave')) calls.leave = true;
    return true;
  };
  // 绕过【时间节流】以便单 tick 断言，但保留体力判定 ——
  // fireIntervalMs() 返回 null 表示体力见底应停火，这条必须仍然生效。
  bot.shoot = (tx, ty, sx, sy) => {
    if (bot.fireIntervalMs() === null) return false; // 体力地板仍然拦截
    calls.shoot.push(`shoot ${Math.round(tx)} ${Math.round(ty)} ${Math.round(sx)} ${Math.round(sy)}`);
    return true;
  };
  bot.calls = calls;
  return bot;
}

// 造一个在 (0,0) 满血的自身、若干可见玩家与若干金币
function seedWorld(bot, { hp = 100, players = [], coins = [] } = {}) {
  bot.world.self = { user_id: 1, hp, max_hp: 100, x: 0, y: 0 };
  bot.world.entities.clear();
  for (const p of players) bot.world.entities.set(p.user_id, { name: 'p' + p.user_id, ...p });
  bot.world.coinDrops.clear();
  for (const c of coins) bot.world.coinDrops.set(c.id || ('c' + c.x + ',' + c.y), { ...c });
}

test('getPlayerGold reads the authoritative death_reward_preview (carried gold)', () => {
  assert.equal(getPlayerGold({ death_reward_preview: 5 }), 5);
  assert.equal(getPlayerGold({ gold: 7 }), 7);
  assert.equal(getPlayerGold({}), 0);
  assert.equal(getPlayerGold({ death_reward_preview: 'abc' }), 0);
  // 关键回归：amount 是金币掉落(drop)的价值字段，绝不能当作玩家的携带金币。
  // 带 amount=9999 的"0 金币"玩家必须被判为 0，否则会被误攻击。
  assert.equal(getPlayerGold({ amount: 9999 }), 0, 'amount 不能算作玩家携带金币');
  assert.equal(getPlayerGold({ coins: 9999 }), 0, 'coins 不能算作玩家携带金币');
});

test('chooseAggroTarget picks richest rich player in radius, skips out-of-range/insufficient', () => {
  const bot = new BridgeBot({ observeOnly: true });
  seedWorld(bot, {
    players: [
      { user_id: 2, death_reward_preview: 4, hp: 100, x: 500, y: 0 },      // 富者，圈内
      { user_id: 3, death_reward_preview: 2, hp: 100, x: 300, y: 0 },      // 金币不足 3
      { user_id: 4, death_reward_preview: 100, hp: 100, x: 999999, y: 0 }, // 圈外（999999cm）
    ],
  });
  const t = chooseAggroTarget(bot.world);
  assert.ok(t, '应选中一个目标');
  assert.equal(t.user_id, 2);
});

test('chooseAggTarget skips dead / missing-coord players', () => {
  const bot = new BridgeBot({ observeOnly: true });
  seedWorld(bot, {
    players: [
      { user_id: 2, death_reward_preview: 50, hp: 0, x: 500, y: 0 }, // 已死
      { user_id: 3, death_reward_preview: 50, hp: 100 },             // 无坐标
    ],
  });
  assert.equal(chooseAggroTarget(bot.world), null);
});

test('chooseAggroTarget ignores players carrying 0 gold even if amount is large (regression)', () => {
  const bot = new BridgeBot({ observeOnly: true });
  seedWorld(bot, {
    players: [
      // 用户实测 bug：周围玩家 0 金币却被打。amount 是 drop 价值字段，数值再大也不能触发攻击。
      { user_id: 2, amount: 99999, death_reward_preview: 0, hp: 100, x: 500, y: 0 },
      { user_id: 3, amount: 99999, hp: 100, x: 300, y: 0 }, // 无 death_reward_preview 一律视为 0
    ],
  });
  assert.equal(chooseAggroTarget(bot.world), null, '0 金币玩家不应成为攻击目标');
});

test('tick actively attacks rich player in radius at HP>=escapeHp even if not full HP', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 90, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.shoot.length > 0, '应开火攻击高金币玩家');
  assert.equal(bot.aggroTargetId, 2, '应锁定攻击目标');
  // 目标还活着(hp>0)：不记录掉落（新设计只在观察到死亡时才记录，避免满血后白等）。
  assert.equal(bot.pendingRichDrop, null, '目标未死，不应记录掉落');
});

test('aggro lock cleared on dead target records rich drop from last known pos', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 0, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot._aggroTargetLastHp = 5; // 之前观测到它还活着(5hp)，现在 hp=0 确认死亡
  bot._aggroTargetLastPos = { x: 500, y: 0 };

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '目标死亡应解除锁定');
  assert.ok(bot.pendingRichDrop, '目标死亡应记录掉落坐标');
  assert.equal(bot.pendingRichDrop.x, 500);
  assert.equal(bot.pendingRichDrop.y, 0);
});

test('REG: target vanishing while IN RANGE is treated as a kill -> goes to pick up its drop', () => {
  // 实测 bug：打死人后没去捡。原因是服务器击杀后直接移除实体、不广播 hp=0，
  // 而旧判据要求"看到 hp<=0"，于是把击杀误判成"跑掉了"，清空了待拾取记录。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot._aggroTargetLastHp = 20;                       // 最后观测还有血（致命一击那帧未广播）
  bot._aggroTargetLastPos = { x: 500, y: 0, d: 500 }; // 消失时在射程内(5m)

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '目标消失应解除锁定');
  assert.ok(bot.pendingRichDrop, '射程内消失应判定击杀并记录掉落点');
  assert.equal(bot.pendingRichDrop.x, 500);
});

test('target vanishing FAR AWAY is treated as escaped -> no stale drop wait', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [], coins: [{ id: 'c', x: 1000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot._aggroTargetLastHp = 100;
  bot._aggroTargetLastPos = { x: 90000, y: 0, d: 90000 }; // 消失时在 900m（远超射程）

  bot.tick();

  assert.equal(bot.pendingRichDrop, null, '射程外消失属于跑掉，不应残留待拾取');
});

test('REG: pending drop is picked up BEFORE locking a new rich target', () => {
  // 实测 bug 的第二个成因：杀死 A 后圈内还有富人 B，
  // 主动攻击(第3层)优先于拾金(第5层) -> 立刻锁定 B，永远走不到拾取 A 掉落那一步。
  const bot = seedBotBridge();
  seedWorld(bot, {
    hp: 100,
    players: [{ user_id: 3, name: 'B-rich', death_reward_preview: 99, hp: 100, x: 800, y: 0 }],
    coins: [{ id: 'dropA', x: 50, y: 0, amount: 40 }], // A 的掉落就在脚下
  });
  bot.state = 'SCAVENGING';
  bot.pendingRichDrop = { x: 50, y: 0, at: Date.now() }; // 刚杀死 A

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '有待拾取掉落时不应立刻锁定新富人 B');
  assert.equal(bot.pendingRichDrop, null, '应先把 A 的掉落捡掉');
  assert.ok(bot.calls.shoot.length === 0, '不应转去攻击 B');
});

test('tick does not aggro when HP < escapeHp (85)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 84, players: [{ user_id: 2, name: 'rich', death_reward_preview: 500, hp: 100, x: 500, y: 0 }] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] }); // 正在被打
  bot.state = 'SCAVENGING';
  bot.escape = () => {}; // 短路逃生，只验证"不应主动攻击"

  bot.tick();

  assert.notEqual(bot.state, 'RETALIATING', 'HP<85 不能进入攻击状态');
  assert.ok(bot.calls.shoot.length === 0, 'HP<85 不应主动开火');
});

test('not full HP: does NOT pick up the rich drop — waits to recover to full HP first', () => {
  // 用户规则：任何时候都要 100 满血才能拾取金币。即使击杀目标掉落了金币，
  // 未满血(70)也不去捡，先回满血。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 70, players: [], coins: [{ id: 'drop', x: 500, y: 0, amount: 50 }] });
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };

  bot.tick();

  assert.equal(bot.state, 'WAITING_FOR_FULL_HP', '未满血应停留在回血状态');
  // 只允许"停下"指令，不能有任何朝金币移动的指令
  assert.ok(bot.calls.vel.every((v) => v === 'vel 0 0'), '未满血不能移动去捡金币');
  assert.ok(bot.pendingRichDrop, '掉落记录保留，等满血后再捡');
});

test('full HP: scavenge picks up pending rich drop first', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [], coins: [{ id: 'drop', x: 50, y: 0, amount: 50 }] });
  bot.state = 'SCAVENGING';
  bot.pendingRichDrop = { x: 50, y: 0, at: Date.now() };

  bot.tick();

  // 掉落就在脚下(50cm < 1m 半径) -> 直接拾取并清空
  assert.equal(bot.pendingRichDrop, null, '拾取完成后应清空掉落记录');
});

test('drop pickup timeout clears the pending drop and resumes normal scavenging', () => {
  // 掉落超时判定发生在满血拾取时：满血但找不到掉落，30s 超时后放弃并继续正常拾金。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, coins: [] }); // 满血但地图上没有任何金币
  bot.state = 'SCAVENGING';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() - 40000 }; // 40 秒前 = 超时

  bot.tick();

  assert.equal(bot.pendingRichDrop, null, '超时应清空掉落记录');
  assert.equal(bot.state, 'SCAVENGING', '超时后应继续正常拾金（不再有回血等待）');
});

test('HP<85 + nearby player but NOT attacked: stands still, no teleport, no logout', () => {
  const bot = seedBotBridge();
  // 用户规则：低血【没人打我就先不动】—— 不传送、不下线、不拾金，站定回血。
  seedWorld(bot, { hp: 70, players: [{ user_id: 2, name: 'nearby', hp: 100, x: 500, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 3000000; // 体力充足也不该传送
  bot.world.self.stamina_1d_remaining_milli = 20000000;
  bot.state = 'SCAVENGING';
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };
  const cmds = [];
  bot.emit = (c) => { cmds.push(c); return true; };

  bot.tick();

  assert.ok(!cmds.some((c) => c.startsWith('tp ')), '没挨打不应传送');
  assert.equal(left, false, '没挨打不应下线');
  assert.equal(bot.state, 'WAITING_FOR_FULL_HP', '应站定回血');
  assert.ok(cmds.every((c) => c === 'vel 0 0'), '应站定不动');
});

test('REG: report() does not spam when two messages alternate or numbers fluctuate', () => {
  // 实测 bug：每 tick 两处 report 交替(A,B,A,B) + 消息里嵌每帧变化的 D=59m，
  // 让"和上一行比较"的去重完全失效 -> 20 行/秒刷屏。
  const bot = seedBotBridge();
  // 用哨兵检测"这次调用是否真的打印了"：lastLogged 只在实际打印时才被赋值。
  const printed = (msg) => {
    bot.lastLogged = '__SENTINEL__';
    bot.report(msg);
    return bot.lastLogged !== '__SENTINEL__';
  };

  assert.equal(printed('原地回血 HP 82/100(站定不动) 最近玩家 D=59m'), true, '首次应打印');
  // 仅数字变化的同类消息：应被去重压制
  assert.equal(printed('原地回血 HP 82/100(站定不动) 最近玩家 D=58m'), false, '仅数字变化不应重复打印');
  assert.equal(printed('原地回血 HP 82/100(站定不动) 最近玩家 D=59m'), false, '数值抖动不应重复打印');
  assert.equal(printed('原地回血 HP 82/100(站定不动) 最近玩家 D=60m'), false, '数值抖动不应重复打印');
  assert.equal(bot.stateMsg, '原地回血 HP 82/100(站定不动) 最近玩家 D=60m', 'stateMsg 仍应实时更新');

  // 真正不同类的状态消息应立即打印
  assert.equal(printed('前往金币 D=12m'), true, '不同类的消息应立即打印');

  // 交替(A,B,A,B)也不应把去重打穿：回到 A 类时仍在最小间隔内 -> 压制
  assert.equal(printed('原地回血 HP 82/100(站定不动) 最近玩家 D=59m'), false, '交替消息不应刷屏');
});

test('REG: HP<85 + nearby player + no teleport stamina => stands still, does NOT log out', () => {
  // 实测死循环复现：上线 HP70、附近有人、传送体力不足 —— 曾直接下线，
  // 而下线不回血 => 回来还是 HP70 => 又下线，永远出不来。必须站定回血。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 70, players: [{ user_id: 2, name: 'nearby', hp: 100, x: 500, y: 0 }] });
  bot.world.canTeleport = () => false; // 体力不足
  bot.state = 'SCAVENGING';
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();

  assert.equal(left, false, '传送不可用时绝不能下线（否则形成上线即下线死循环）');
  assert.equal(bot.state, 'WAITING_FOR_FULL_HP', '应转为站定回血');
  assert.ok(bot.calls.vel.every((v) => v === 'vel 0 0'), '应站定不动回血');
});

test('HP<85 + UNDER ATTACK: emergency escape may log out (worth the cost)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 70, players: [{ user_id: 2, name: 'attacker', hp: 100, x: 500, y: 0 }] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 2, x: 0, y: 0 }] });
  bot.state = 'SCAVENGING';
  let escaped = false;
  bot.escape = () => { escaped = true; };

  bot.tick();

  assert.equal(escaped, true, '低血且正在挨打应走紧急撤离');
  assert.equal(bot.state, 'ESCAPING');
});

test('HP<85 with NO player nearby: stands still to regen (never a death loop)', () => {
  const bot = seedBotBridge();
  // 附近无人 —— 不逃生（否则会"低血重进→立刻再下线"死循环），站定回血。
  seedWorld(bot, { hp: 60, players: [], coins: [{ id: 'c', x: 1000, y: 0 }] });
  bot.state = 'WAITING_FOR_FULL_HP';
  let escaped = false;
  bot.escape = () => { escaped = true; };

  bot.tick();

  assert.equal(escaped, false, '无人时不应逃生');
  assert.equal(bot.state, 'WAITING_FOR_FULL_HP');
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(!lastVel || lastVel === 'vel 0 0', '应站定不动回血，不移动');
});

test('recovering NEVER oscillates: stands still even with a player in mid-range', () => {
  const bot = seedBotBridge();
  // 实测 bug 复现：玩家在 188m 时曾在 188~191m 间无限震荡、永不回血。
  // HP 90(>85 不触发逃生)、无人开火 —— 必须站定回血，绝不移动。
  seedWorld(bot, { hp: 90, players: [{ user_id: 2, name: 'mid', hp: 100, x: 18800, y: 0 }] });
  bot.state = 'WAITING_FOR_FULL_HP';

  bot.tick();
  bot.tick();
  bot.tick();

  assert.equal(bot.state, 'WAITING_FOR_FULL_HP');
  assert.ok(bot.calls.vel.every((v) => v === 'vel 0 0'), '回血期绝不能有任何移动指令（防震荡）');
  assert.ok(bot.calls.shoot.length === 0, '回血期不应开火');
});

test('recovering with no player nearby stands still to recover', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 60, players: [] }); // 无人
  bot.state = 'WAITING_FOR_FULL_HP';

  bot.tick();

  assert.equal(bot.state, 'WAITING_FOR_FULL_HP');
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(!lastVel || lastVel === 'vel 0 0', '无人时停下回血不消耗体力');
});

test('aggro target is locked: keeps attacking same player even if gold drops below threshold', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.tick();
  assert.equal(bot.aggroTargetId, 2, '首次应锁定目标');

  const shootsAfterFirst = bot.calls.shoot.length;
  // 目标金币掉到 0（比如他消费了），但还活着 —— 锁定必须保持，继续打死为止。
  bot.world.entities.get(2).death_reward_preview = 0;
  bot.state = 'SCAVENGING';
  bot.tick();

  assert.equal(bot.state, 'RETALIATING', '锁定目标未死前不换目标');
  assert.ok(bot.calls.shoot.length > shootsAfterFirst, '继续开火直到打死目标');
  assert.equal(bot.aggroTargetId, 2, '锁定不因金币变化而中断');
});

test('aggro lock is cleared when target dies', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.tick();
  assert.equal(bot.aggroTargetId, 2);
  const shootsBefore = bot.calls.shoot.length;

  // 目标死亡（hp 0）
  bot.world.entities.get(2).hp = 0;
  bot.state = 'SCAVENGING';
  bot.tick();

  assert.equal(bot.aggroTargetId, null, '目标死亡后应解除锁定');
  assert.ok(bot.calls.shoot.length === shootsBefore, '不应再攻击已死亡目标');
});

test('retaliates against attacker regardless of gold count (0-gold attacker)', () => {
  const bot = seedBotBridge();
  // 攻击者携带 0 金币（不满足 aggro 圈内富人条件），但正在打我 —— 必须反击。
  seedWorld(bot, { hp: 95, players: [{ user_id: 2, name: 'attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 }] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 2, x: 0, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.state, 'RETALIATING', '被攻击应进入反击');
  assert.ok(bot.calls.shoot.length > 0, '0 金币攻击者也应反击');
});

test('aggro lock yields to retaliation when attacked by someone else', () => {
  const bot = seedBotBridge();
  // 已锁定富人 A(2)，同时被 0 金币的 B(3) 攻击 —— 应转反击 B。
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'A-rich', death_reward_preview: 50, hp: 100, x: 800, y: 0 },
    { user_id: 3, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },
  ] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2; // 已锁定 A
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 3, x: 0, y: 0 }] });

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '被攻击时应让出主动攻击锁定');
  assert.equal(bot.state, 'RETALIATING');
  const lastShoot = bot.calls.shoot[bot.calls.shoot.length - 1];
  assert.ok(lastShoot && lastShoot.includes('500'), '应转向攻击攻击者 B(500)');
});

test('REG: identifies the SHOOTER even when the bullet position does not line up', () => {
  // 双重回归：
  //  ① 打中我的子弹在命中瞬间就被移除/位置对不上时，仍要认出攻击者并马上还击
  //     （旧判据要求"子弹落在我身边 2m 内"，几乎永不成立 -> 挨打了不还手）
  //  ② 但绝不能打旁边更近的 0 金币旁观者 C（判据是"他在开枪"，C 没子弹 -> 排除）
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'C-bystander', death_reward_preview: 0, hp: 100, x: 300, y: 0 }, // 更近但没开枪
    { user_id: 3, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },  // 开枪的人
  ] });
  // 子弹位置(99999)与掉血位置完全对不上，但 owner 表明 3 号在开枪
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 3, x: 99999, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.state, 'RETALIATING', '应立刻进入反击');
  assert.equal(bot.retalTargetId, 3, '应锁定开枪的 3 号，而不是更近的旁观者 2 号');
  const lastShoot = bot.calls.shoot[bot.calls.shoot.length - 1];
  assert.ok(lastShoot && lastShoot.includes('500'), '应朝攻击者(500)开火，而非旁观者(300)');
});

test('REG: nobody shooting => no retaliation target (innocent bystanders stay safe)', () => {
  // 掉血但场上没有任何人的子弹（例如摔落/环境伤害）：不能乱打旁边的人。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'C-bystander', death_reward_preview: 0, hp: 100, x: 300, y: 0 },
  ] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.retalTargetId, null, '无人开枪时不应锁定任何人');
  assert.ok(bot.calls.shoot.length === 0, '无人开枪时不应开火');
  // 仍要横移躲避，不站桩
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(lastVel && lastVel !== 'vel 0 0', '应横移躲避而非站桩');
});

test('remembers recent shooters: retaliates even after the bullet is gone', () => {
  // 命中瞬间子弹被服务器移除 -> 掉血帧里 bullets 已空。
  // 靠 recentShooters 记忆仍应认出攻击者并还击。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [
    { user_id: 3, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },
  ] });
  // 上一帧看到过 3 号的子弹
  bot.world.recentShooters.set(3, Date.now());
  // 本次掉血帧里子弹已经没了
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.retalTargetId, 3, '应凭"刚刚开过枪"的记忆锁定攻击者');
  assert.ok(bot.calls.shoot.length > 0, '应还击');
});

test('retaliation locks onto the confirmed attacker, not the nearest player', () => {
  const bot = seedBotBridge();
  // 攻击者 B 在 500，更近的人 C 在 300（C 没打我）—— 必须打 B，不能打 C。
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },
    { user_id: 3, name: 'C-closer', death_reward_preview: 0, hp: 100, x: 300, y: 0 },
  ] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 2, x: 0, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.retalTargetId, 2, '应锁定攻击者 B');
  const lastShoot = bot.calls.shoot[bot.calls.shoot.length - 1];
  assert.ok(lastShoot && lastShoot.includes('500'), '应打攻击者 B(500) 而非更近的 C(300)');
});

test('retaliation lock persists even when bullet association temporarily fails', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },
    { user_id: 3, name: 'C-closer', death_reward_preview: 0, hp: 100, x: 300, y: 0 },
  ] });
  bot.state = 'SCAVENGING';
  // 首次确认攻击者 B
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 2, x: 0, y: 0 }] });
  bot.tick();
  assert.equal(bot.retalTargetId, 2);

  const shootsBefore = bot.calls.shoot.length;
  // 下一次掉血：子弹关联失败（bullets 为空，且更近的 C 在旁）
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  bot.tick();

  assert.equal(bot.retalTargetId, 2, '锁定后不因关联失败/旁边有更近的人而换目标');
  assert.ok(bot.calls.shoot.length > shootsBefore, '继续攻击 B');
  const lastShoot = bot.calls.shoot[bot.calls.shoot.length - 1];
  assert.ok(lastShoot && lastShoot.includes('500'), '仍打 B(500) 而非 C(300)');
});

test('under attack but attacker unidentifiable: does NOT attack surrounding players', () => {
  const bot = seedBotBridge();
  // 没有任何可见玩家可被误判
  seedWorld(bot, { hp: 100, players: [] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.ok(bot.calls.shoot.length === 0, '无法确认攻击者时不能乱开火');
  assert.ok(bot.calls.vel.length === 0 || bot.calls.vel[bot.calls.vel.length - 1] === 'vel 0 0', '应原地戒备');
});

test('retaliation lock clears when no longer under attack', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 2, x: 0, y: 0 }] });
  bot.tick();
  assert.equal(bot.retalTargetId, 2);

  // 掉血事件已过 5s 窗口（不再认为被攻击）
  bot.world.hpEvents[0].at = Date.now() - 8000;
  bot.state = 'SCAVENGING';
  bot.tick();

  assert.equal(bot.retalTargetId, null, '不再被攻击时应解除反击锁定');
});

test('aggro chases target that leaves shoot range but stays visible', () => {
  const bot = seedBotBridge();
  // 目标在 160m（>150m 射程，但 <2000m 追逐上限）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 16000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2; // 已锁定

  bot.tick();

  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.vel.length > 0, '应向目标方向移动追击');
  assert.notEqual(bot.calls.vel[bot.calls.vel.length - 1], 'vel 0 0', '追击时不能停下');
});

test('aggro gives up chasing after the 90s chase timeout (target never caught)', () => {
  const bot = seedBotBridge();
  // 目标在 160m（已出攻击圈 109m，正在追击）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 16000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  // 追击计时从 91 秒前开始 = 已超时
  bot.aggroChaseSince = Date.now() - (CONFIG.aggroChaseTimeoutMs + 1000);

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '追击超时应放弃目标');
  assert.equal(bot.aggroChaseSince, 0, '放弃后追击计时应清零');
  assert.equal(bot.pendingRichDrop, null, '目标未死，不应残留掉落记录');
  assert.ok(bot.calls.shoot.length === 0, '放弃后不应再开火');
});

test('chase timer starts when leaving the AGGRO CIRCLE (= bullet range 150m)', () => {
  const bot = seedBotBridge();
  // 攻击圈 = 射程 150m。目标在圈外(160m) -> 应开始追击计时。
  const outside = CONFIG.aggroRadiusCm + 1000;
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: outside, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot.aggroChaseSince = 0;

  bot.tick();

  assert.ok(bot.aggroChaseSince > 0, '出攻击圈即应开始追击计时');
});

test('REG: stuck while scavenging => detour actually changes the movement direction', () => {
  // 实测 bug：拾金路上卡住(D=168m 十几分钟不变)，卡住告警反复打印却一直不动。
  // 根因：卡住只翻转 _strafeDir，而 moveToCoin 根本不用该变量 -> 修复完全无效。
  // 现在卡住会进入"绕行"，给方向叠加垂直偏移，真正换一条路线。
  const bot = seedBotBridge();
  // 金币在正东方，直线方向应是 (1,0)
  seedWorld(bot, { hp: 100, players: [], coins: [{ id: 'c', x: 16800, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.world.self.stamina_1h_remaining_milli = 3000000;
  bot.world.self.stamina_1d_remaining_milli = 20000000;
  bot.state = 'SCAVENGING';

  // 正常情况：直线朝金币
  bot.tick();
  const normal = bot.calls.vel[bot.calls.vel.length - 1];
  assert.equal(normal, 'vel 1 0', '正常应直线朝金币(+x)');

  // 进入绕行期
  bot.calls.vel.length = 0;
  bot._detourUntil = Date.now() + 2000;
  bot.lastVelSent = null; // 允许重新发送
  bot.lastVelAt = 0;
  bot.tick();
  const detour = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(detour, '绕行期应仍在移动');
  assert.notEqual(detour, 'vel 1 0', '绕行期方向必须与直线不同(真正换路线)');
  assert.match(bot.stateMsg, /绕行中/, '状态消息应标明绕行中');
});

test('REG: stuck due to exhausted stamina is reported as such (not as a blocked path)', () => {
  // 体力耗尽时服务器会拒绝移动，表现也是"不动"。必须与"被挡住"区分开，
  // 否则会一直无效地绕行。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [], coins: [{ id: 'c', x: 16800, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 0; // 1h 体力耗尽
  bot.state = 'SCAVENGING';
  assert.equal(bot.world.canMove(), false, '体力耗尽应判定为无法移动');

  // 构造"已移动但位移不足"的卡住条件
  bot.lastVelSent = 'vel 1 0';
  bot._stuckCheckAt = Date.now() - (CONFIG.evadeStuckWindowMs + 1000);
  bot._stuckCheckPos = { x: 0, y: 0 };

  let warned = '';
  const origWarn = log.warn;
  log.warn = (...a) => { warned += a.join(' '); };
  try {
    bot.tick();
  } finally {
    log.warn = origWarn;
  }

  assert.match(warned, /体力耗尽/, '应报告体力耗尽，而不是当作被挡住去绕行');
  assert.equal(bot._detourUntil, 0, '体力耗尽时不应进入绕行(绕行无用)');
});

test('canMove reflects all three stamina windows', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.world.self.stamina_1h_remaining_milli = 3000000;
  bot.world.self.stamina_1d_remaining_milli = 20000000;
  assert.equal(bot.world.canMove(), true, '三窗口都充足应可移动');

  bot.world.self.stamina_1d_remaining_milli = 0; // 日额度耗尽
  assert.equal(bot.world.canMove(), false, '任一窗口耗尽即无法移动');
});

test('REG: attacks a rich player after long scavenging (1h stamina line must not silence aggro)', () => {
  // 实测 bug：拾金 bot 连续跑 ~25 分钟后 1h 体力跌破 1500 点门槛，
  // 主动攻击【静默停止】—— 10 金币的人靠到身边也毫无反应。
  // 门槛必须低到"长时间拾金后仍能开战"。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich10', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  // 已消耗大半 1h 体力（典型挂机场景）
  bot.world.self.stamina_1h_remaining_milli = 1200 * 1000; // 1200 点
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.aggroTargetId, 2, '长时间拾金后仍应主动攻击 10 金币的目标');
  assert.ok(bot.calls.shoot.length > 0, '应开火');
});

test('1h stamina truly exhausted still blocks NEW aggro (keep mobility to disengage)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich10', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 50 * 1000; // 仅 50 点，未及保机动门槛(80)
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '体力真见底时不应开新战（保住脱离能力）');
});

test('diagnoses why a qualified rich target was not attacked', () => {
  // 圈内有够格目标却没打时，必须打出【具体原因】，不能让人靠猜。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich10', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 50 * 1000; // 体力见底(50<门槛80) -> 会被拦
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  let warned = '';
  const origWarn = log.warn;
  log.warn = (...a) => { warned += a.join(' '); };
  try {
    bot.tick();
  } finally {
    log.warn = origWarn;
  }

  assert.match(warned, /未主动攻击/, '应输出未攻击的诊断');
  assert.match(warned, /1h体力/, '应指明是体力门槛拦住的');
  assert.match(warned, /rich10/, '应指明是哪个目标');
});

test('fire rate: full 5s stamina => server max rate (burst)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [] });
  bot.world.self.stamina_5s_remaining_milli = 10000; // 满
  assert.equal(bot.fireIntervalMs(), 100, '体力充足应按服务器上限 100ms/发');
});

test('fire rate: mid 5s stamina => sustainable rate (slower than max)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [] });
  bot.world.self.stamina_5s_remaining_milli = 5000; // 5点
  const iv = bot.fireIntervalMs();
  assert.ok(iv > 100, '体力中等应降速到可持续速率，而非服务器上限');
  assert.ok(iv < 1000, '也不该慢到几乎不开火');
});

test('REG: 5s stamina below floor => HOLD FIRE (never freeze from exhaustion)', () => {
  // 规则：体力耗尽无法攻击也无法移动 => 不能逃 => 死 => 掉光金币。必须无条件防住。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = CONFIG.fireStaminaFloorMilli - 500; // 低于地板
  bot.state = 'SCAVENGING';

  assert.equal(bot.fireIntervalMs(), null, '低于地板应停火');

  bot.tick();

  assert.ok(bot.calls.shoot.length === 0, '体力见底不应开火');
  // 仍应移动（保命优先），或处于脉冲的停顿相位
  assert.equal(bot.state, 'RETALIATING', '仍在交战状态，只是不开火');
});

test('combat move: pulse-strafe alternates moving and pausing (stamina duty cycle)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [] });
  // 直接验证脉冲相位函数在一个周期内既有 true 也有 false
  const period = CONFIG.strafePulseRunMs + CONFIG.strafePulsePauseMs;
  let on = 0, off = 0;
  for (let t = 0; t < period; t += 50) {
    if (bot._strafePulseOn(t)) on++; else off++;
  }
  assert.ok(on > 0 && off > 0, '脉冲走位应有"跑"和"停"两个相位');
  assert.ok(off > on, '停顿应多于移动(占空比 <0.5)，以省体力给射击');
});

test('combat move: closes distance when beyond optimal range (diagonal approach)', () => {
  const bot = seedBotBridge();
  // 目标在 140m（> 逼近阈值 120m），在 +x 方向
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 14000, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot._strafeDir = 1;

  // 强制处于"跑"相位以便断言方向
  bot._strafePulseOn = () => true;
  bot.tick();

  const vels = bot.calls.vel.filter((v) => v !== 'vel 0 0');
  assert.ok(vels.length > 0, '应有移动');
  // 斜向逼近：x 分量必须为 +1（朝目标缩短距离），而非纯横移的 0
  assert.ok(vels.some((v) => v.startsWith('vel 1')), '远距离应斜向逼近(含朝目标的 +x 分量)');
});

test('does not fire beyond fireMaxRange even inside the aggro circle', () => {
  const bot = seedBotBridge();
  // 148m：在攻击圈(150m)内，但超出有效开火距离(145m) -> 只逼近不开火
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 14800, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;

  bot.tick();

  assert.ok(bot.calls.shoot.length === 0, '超出有效射程不应开火(白烧体力)');
  const vels = bot.calls.vel.filter((v) => v !== 'vel 0 0');
  assert.ok(vels.length > 0, '应逼近到有效射程内');
});

test('ineffective fire: NON-locked target with no HP drop for 6s => give up and blacklist', () => {
  // 非我主动锁定的目标（误锁/站桩无敌）：持续开火打不掉就拉黑，避免白烧体力。
  // 直接用 _trackFireEffect 单测判定分支，不经过 tick（tick 会自动锁定圈内富人）。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'invincible', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.aggroTargetId = null; // 未主动锁定
  // 已持续开火 7 秒且 HP 从未变化
  bot._fireEffect = { id: 2, since: Date.now() - (CONFIG.ineffectiveFireMs + 1000), startHp: 100, lastHp: 100 };

  bot._trackFireEffect(bot.world.entities.get(2), Date.now(), true);

  assert.ok(bot._ineffective.has(2), '非锁定目标应拉黑');
  assert.equal(bot.aggroTargetId, null, '非锁定目标应放弃');
});

test('REG: actively LOCKED target with no HP drop is NOT blacklisted — keep fighting (kill him dead)', () => {
  // 用户要求：优先和他对打，打死他为止。主动锁定目标哪怕 6s 无伤也不拉黑、不脱离。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'escapee', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2; // 我主动锁定着他
  bot._aggroLockedSince = Date.now(); // 刚锁上
  // 已持续开火 7 秒且 HP 从未变化
  bot._fireEffect = { id: 2, since: Date.now() - (CONFIG.ineffectiveFireMs + 1000), startHp: 100, lastHp: 100 };

  bot.tick();

  assert.equal(bot.aggroTargetId, 2, '主动锁定目标不应被拉黑/解除锁定');
  assert.ok(!bot._ineffective.has(2), '不应拉黑主动锁定目标');
});

test('REG: actively LOCKED target unkillable for the full 90s timeout => finally give up', () => {
  // 防"目标真的无敌"无限白烧体力：锁定总时长超过 aggroChaseTimeoutMs 就放弃。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'trulyInvincible', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot._aggroLockedSince = Date.now() - (CONFIG.aggroChaseTimeoutMs + 1000); // 已锁 91s
  bot._fireEffect = { id: 2, since: Date.now() - (CONFIG.ineffectiveFireMs + 1000), startHp: 100, lastHp: 100 };

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '锁定超 90s 打不动应放弃');
  assert.ok(!bot._ineffective.has(2), '放弃的是主动锁定目标，不应拉黑（下次能再锁）');
});

test('fire effect timer PAUSES while target is out of shoot range (pursuit)', () => {
  // 目标跑出射程(追击中)：这段"无伤时间"不算数，暂停计时；回射程才重新累计。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'chaser', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = null;
  bot._fireEffect = { id: 2, since: Date.now() - (CONFIG.ineffectiveFireMs + 1000), startHp: 100, lastHp: 100 }; // 已"超时"

  // 目标此刻在射程外(追击中)：inRange=false -> since 被重置到 now，不再触发拉黑。
  bot._trackFireEffect(bot.world.entities.get(2), Date.now(), false);

  assert.ok(!bot._ineffective.has(2), '射程外追击不应触发拉黑');
  // 回到射程后重新累计：此时距离超时还差满 ineffectiveFireMs
  const fe = bot._fireEffect;
  assert.ok(fe && Date.now() - fe.since < 100, '射程外时应重置无伤计时起点');
});

test('blacklisted target is not re-locked while blacklisted', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'invincible', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot._ineffective.set(2, Date.now() + CONFIG.ineffectiveBlacklistMs);

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '拉黑期内不应重新锁定');
  assert.ok(bot.calls.shoot.length === 0, '拉黑期内不应开火');
});

test('inside the aggro circle the chase timer stays at zero', () => {
  const bot = seedBotBridge();
  // 目标在圈内(120m < 150m) -> 不算"追"，计时保持 0
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 12000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot.aggroChaseSince = 0;

  bot.tick();

  assert.equal(bot.aggroChaseSince, 0, '圈内不应计时');
});

test('re-entering the aggro circle RESTARTS the chase timer', () => {
  const bot = seedBotBridge();
  // 目标回到 50m（攻击圈内）—— 计时应清零（用户规则：重新计时，继续攻击他）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot.aggroChaseSince = Date.now() - 80000; // 已追 80s，此刻回到圈内

  bot.tick();

  assert.equal(bot.aggroChaseSince, 0, '回到攻击圈内应重新计时(清零)');
  assert.ok(bot.calls.shoot.length > 0, '应继续攻击他');
});

test('after giving up, target re-entering the circle can be re-locked (no cooldown)', () => {
  const bot = seedBotBridge();
  // 刚放弃过（无锁定），目标此刻在攻击圈内(50m) —— 应立即重新锁定并攻击。
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 5000, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = null;

  bot.tick();

  assert.equal(bot.aggroTargetId, 2, '重新进入攻击圈应能立刻重锁（不设放弃冷却）');
  assert.equal(bot.aggroChaseSince, 0, '圈内锁定时计时为 0');
  assert.ok(bot.calls.shoot.length > 0, '应攻击他');
});

test('teleport success clears pending rich drop', () => {
  const bot = seedBotBridge();
  bot.escapePhase = 'teleporting';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };

  bot.onTeleportAck(true);

  assert.equal(bot.pendingRichDrop, null, '传送成功应清空待拾取掉落');
});

test('leaveAndCooldown clears pending rich drop and target locks', () => {
  const bot = seedBotBridge();
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };
  bot.aggroTargetId = 2;
  bot.retalTargetId = 3;

  bot.leaveAndCooldown('测试');

  assert.equal(bot.pendingRichDrop, null, '下线应清空待拾取掉落');
  assert.equal(bot.aggroTargetId, null, '下线应清空主动锁定');
  assert.equal(bot.retalTargetId, null, '下线应清空反击锁定');
});

test('aggro resets chase timer when target is back in shoot range', () => {
  const bot = seedBotBridge();
  // 目标回到射程内（5m）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2;
  bot.aggroChaseSince = Date.now() - 80000; // 已追了 80s，但此刻回到射程

  bot.tick();

  assert.equal(bot.aggroChaseSince, 0, '回到射程应重置追击计时');
  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.shoot.length > 0, '回射程应继续开火');
});

test('low stamina blocks NEW aggro lock but keeps existing fight (stamina reserve)', () => {
  const bot = seedBotBridge();
  // 1h 体力只剩 50s(50000ms) < 保机动门槛(80000ms)，有富人在圈内 —— 不应主动锁定新目标。
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 50, hp: 100, x: 500, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 50000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '体力过低时不应主动锁定新目标');
  assert.ok(bot.calls.shoot.length === 0, '体力过低时不应主动开火');
});

test('low stamina does NOT interrupt an already-locked fight', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 50, hp: 100, x: 500, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 100000; // 低体力
  bot.state = 'SCAVENGING';
  bot.aggroTargetId = 2; // 战斗进行中

  bot.tick();

  assert.equal(bot.state, 'RETALIATING', '已有锁定战斗不因体力低而中断');
  assert.ok(bot.calls.shoot.length > 0, '应继续攻击已锁定目标');
});

test('stuck detection flips strafe direction when moving but not making progress', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [], coins: [{ id: 'coin', x: 1000, y: 0 }] });
  bot.state = 'SCAVENGING';
  // 模拟持续移动但几乎没位移（顶到边界）
  bot.lastVelSent = 'vel 1 0';
  bot._strafeDir = 1;
  bot._stuckCheckAt = Date.now() - (CONFIG.evadeStuckWindowMs + 1000); // 超过检测窗口
  bot._stuckCheckPos = { x: 0, y: 0 }; // 起点
  bot.world.self.x = 5; // 只挪了 5cm(<10m 阈值)

  bot.tick();

  assert.equal(bot._strafeDir, -1, '卡住应翻转横移方向');
});

test('strafeDirection is perpendicular to the self-target line', () => {
  // 目标在正东方：横移方向应为 (0,±1) 之一（垂直）
  const s = strafeDirection({ x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.ok(Math.abs(s.dx) < 1e-9, 'dx 应≈0（垂直于连线）');
  assert.ok(Math.abs(Math.abs(s.dy) - 1) < 1e-9, 'dy 应≈±1');
});

test('tick moves while attacking (pulse-strafe: never permanently stationary)', () => {
  const bot = seedBotBridge();
  // 目标在射程内（5m）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  // 脉冲走位有合法的"停顿相位"，所以不能只看某一刻；
  // 强制处于"跑"相位，验证攻击时确实会移动（不是永久站桩）。
  bot._strafePulseOn = () => true;
  bot.tick();

  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.shoot.length > 0, '应开火');
  const moves = bot.calls.vel.filter((v) => v !== 'vel 0 0');
  assert.ok(moves.length > 0, '攻击中的"跑"相位应确实移动，而非站桩');
});

// ---- 弹道提前量(leadPoint) ----

test('leadPoint: static target returns current position (no worse than today)', () => {
  const p = leadPoint({ x: 0, y: 0 }, { x: 1000, y: 0, vx: 0, vy: 0 }, 30000);
  assert.deepEqual(p, { x: 1000, y: 0 }, '静止目标应打当前位置');
});

test('leadPoint: moving target leads to its predicted position', () => {
  // self 在原点，目标在 +x 方向 100m，以 10m/s(1000cm/s) 向外跑；子弹速 300m/s。
  const p = leadPoint({ x: 0, y: 0 }, { x: 10000, y: 0, vx: 1000, vy: 0 }, 30000);
  // t ≈ 100m/300mps ≈ 0.33s -> 目标前移 ~33cm..为保证方向正确，只断言在目标前方(>10000)。
  assert.ok(p.x > 10000, `瞄准点应前移到目标前方(领先)，实测 x=${p.x}`);
  assert.equal(p.y, 0, 'y 不变（目标只沿 x 移动）');
});

test('leadPoint: unknown/missing bullet speed falls back to current position', () => {
  const p = leadPoint({ x: 0, y: 0 }, { x: 1000, y: 0, vx: 1000, vy: 0 }, 0);
  assert.deepEqual(p, { x: 1000, y: 0 }, '子弹速度未知应打当前位置');
  const p2 = leadPoint({ x: 0, y: 0 }, { x: 1000, y: 0, vx: 1000, vy: 0 }, null);
  assert.deepEqual(p2, { x: 1000, y: 0 }, 'null 也应回退');
  const p3 = leadPoint({ x: 0, y: 0 }, { x: 1000, y: 0 }, 30000); // 无 vx/vy
  assert.deepEqual(p3, { x: 1000, y: 0 }, '无 vx/vy 视为静止');
});

test('leadPoint: converges (2 iterations) for a constant-velocity target', () => {
  // 迭代应快速收敛：3 次与 6 次结果几乎一致
  const self = { x: 0, y: 0 };
  const target = { x: 5000, y: 8000, vx: -700, vy: 1200 };
  const p3 = leadPoint(self, target, 40000, 3);
  const p6 = leadPoint(self, target, 40000, 6);
  assert.ok(Math.abs(p3.x - p6.x) < 1, `迭代应收敛，dx=${Math.abs(p3.x - p6.x)}`);
  assert.ok(Math.abs(p3.y - p6.y) < 1, `迭代应收敛，dy=${Math.abs(p3.y - p6.y)}`);
});

// ---- bot 集成：提前量接入 ----

test('attack uses LEAD point when bullet speed is measured (aims ahead of a moving target)', () => {
  const bot = seedBotBridge();
  bot._bulletSpeedCmS = 30000; // 已实测到 300m/s
  // 目标在 50m、以 10m/s 沿 +x 移动
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 20, hp: 100, x: 5000, y: 0, vx: 1000, vy: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.ok(bot.calls.shoot.length > 0, '应开火');
  const last = bot.calls.shoot[bot.calls.shoot.length - 1];
  // shoot 参数形如 "shoot <tx> <ty> <sx> <sy>"；tx 应领先于目标当前位置 5000(>5000)
  const tx = Number(last.split(' ')[1]);
  assert.ok(tx > 5000, `有提前量时瞄准点应大于目标当前位置(>5000)，实测 tx=${tx}`);
});

test('attack uses config estimated bullet speed when measured value is missing (fallback)', () => {
  // 实测样本凑不齐时（体力掐死射速），用 CONFIG.bulletSpeedCmS 估算值兜底 —— 提前量立刻生效。
  const bot = seedBotBridge();
  bot._bulletSpeedCmS = null; // 尚未实测到
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 20, hp: 100, x: 5000, y: 0, vx: 1000, vy: 0 }] });
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.ok(bot.calls.shoot.length > 0);
  const last = bot.calls.shoot[bot.calls.shoot.length - 1];
  const tx = Number(last.split(' ')[1]);
  // CONFIG.bulletSpeedCmS 默认 300m/s(30000cm/s)，目标 vx=1000cm/s 在 50m：提前量必 > 5000。
  assert.ok(tx > 5000, `配置估算子弹速度时应打提前量(>5000)，实测 tx=${tx}`);
});

// ---- 落地重定向(_maybeRelocate) ----

test('relocate: active pending => moves AWAY from last threat', () => {
  const bot = seedBotBridge();
  bot._pendingRelocate = true;
  bot._relocateTarget = null;
  bot._escapeThreat = { x: 0, y: 0 }; // 威胁在原点(西侧)
  bot.world.self = { user_id: 1, hp: 100, max_hp: 100, x: 0, y: 0 }; // 我在原点附近

  const still = bot._maybeRelocate();

  assert.equal(still, true, '正在转移应返回 true');
  assert.ok(bot._relocateTarget, '应构造目标点');
  assert.ok(bot._relocateTarget.x > 0, '威胁在 -x 侧，目标应在 +x(远离)');
  // 应向 +x 移动
  const vel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.match(vel, /^vel 1/ , '应向远离威胁的方向移动(+x)');
});

test('relocate: completes once close enough to target', () => {
  const bot = seedBotBridge();
  bot._pendingRelocate = true;
  bot._escapeThreat = null; // 无威胁 -> 随机方向(进行了已知目标点)
  bot.world.self = { user_id: 1, hp: 100, max_hp: 100, x: 0, y: 0 };
  // 预置一个几乎已经到达的目标点
  bot._relocateTarget = { x: 110, y: 0 }; // 110m 内即到达
  bot.world.self.x = 0;
  bot.world.self.y = 0;

  // _maybeRelocate 内部依配置 relocateArriveM(120m) 判定到达
  const still = bot._maybeRelocate();

  assert.equal(still, false, '已到目标半径内应完成');
  assert.equal(bot._relocateTarget, null, '完成应清空目标点');
});

test('relocate: not pending (technical leave) does nothing', () => {
  const bot = seedBotBridge();
  bot._pendingRelocate = false;
  bot.world.self = { user_id: 1, hp: 100, max_hp: 100, x: 0, y: 0 };
  assert.equal(bot._maybeRelocate(), false, '非逃生下线不转移');
  assert.equal(bot._relocateTarget, null, '不应构造目标点');
});

// ---- 回归：实测日志场景 ----
// 2026-08-09 实测：1h 体力 186 点时，55 金币 Rauze 在 150m 内却"未主动攻击"。
// 根因是旧门槛 300 点对一直移动的 bot 太苛刻，常态触达把主动攻击静默饿死。
// 门槛降到 80 点后，186 点(>80)必须仍能主动锁定圈内高币目标。
test('REG: 186 points (below old 300, above new 80) still actively attacks an in-range rich target', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'Rauze', death_reward_preview: 55, hp: 100, x: 5000, y: 0 }] });
  bot.world.self.stamina_1h_remaining_milli = 186 * 1000; // 186 点，旧门槛会拦、新门槛(80)不应拦
  bot.world.self.stamina_5s_remaining_milli = 10000;
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.aggroTargetId, 2, '186 点应主动锁定圈内 55 币目标');
  assert.ok(bot.calls.shoot.length > 0, '186 点应主动开火');
});