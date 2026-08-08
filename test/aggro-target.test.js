import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeBot } from '../src/bot-bridge.js';
import { CONFIG } from '../src/config.js';
import { chooseAggroTarget, getPlayerGold, strafeDirection } from '../src/strategy.js';

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
  // 绕过节流：每 tick 调用即记录，目标逻辑与频率节流解耦。
  bot.shoot = (tx, ty, sx, sy) => { calls.shoot.push(`shoot ${Math.round(tx)} ${Math.round(ty)} ${Math.round(sx)} ${Math.round(sy)}`); return true; };
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
  assert.ok(bot.pendingRichDrop, '应记录掉落坐标');
  assert.equal(bot.pendingRichDrop.x, 500);
  assert.equal(bot.pendingRichDrop.y, 0);
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

test('drop pickup timeout (evaluated at full HP) sets recoverAfterMissedDrop', () => {
  // 掉落超时判定发生在满血拾取时：满血但地图上没有任何金币可捡，30s 超时后进入回血恢复。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, coins: [] }); // 满血但地图上没有任何金币
  bot.state = 'SCAVENGING';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() - 40000 }; // 40 秒前 = 超时

  bot.tick();

  assert.equal(bot.recoverAfterMissedDrop, true, '超时应进入原地回血');
  assert.equal(bot.pendingRichDrop, null, '掉落记录应被清空');
  assert.equal(bot.state, 'WAITING_FOR_FULL_HP');
  assert.ok(bot.calls.shoot.length === 0, '回血期间不应攻击');
});

test('after recovering to full HP, recoverAfterMissedDrop clears and resumes', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, coins: [{ id: 'coin', x: 1000, y: 0 }] });
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.recoverAfterMissedDrop = true;

  bot.tick();

  assert.equal(bot.recoverAfterMissedDrop, false, '满血后应解除恢复状态');
  assert.equal(bot.state, 'SCAVENGING');
});

test('recovering (not full HP) keeps strafing when a player is nearby (not a sitting duck)', () => {
  const bot = seedBotBridge();
  // HP 60 未满血、无人攻击、但附近有个玩家 —— 必须横移躲避，不能站桩。
  seedWorld(bot, { hp: 60, players: [{ user_id: 2, name: 'nearby', hp: 100, x: 500, y: 0 }] });
  bot.state = 'WAITING_FOR_FULL_HP';

  bot.tick();

  assert.equal(bot.state, 'WAITING_FOR_FULL_HP', '仍处于回血状态');
  assert.ok(bot.calls.shoot.length === 0, '回血期不应开火');
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(lastVel && lastVel !== 'vel 0 0', '附近有玩家时应保持移动(横移)，而非站桩');
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

test('REG: does not retaliate a 0-gold bystander when bullet association fails (nearest-player fallback)', () => {
  // 用户实测 bug 复现：攻击者 B 的子弹一时对不上时，原代码退化为"打最近的玩家"，
  // 把站在旁边的 0 金币玩家 C 误当攻击者锁定并反击。
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'C-bystander', death_reward_preview: 0, hp: 100, x: 300, y: 0 }, // 更近，0 金币
    { user_id: 3, name: 'B-attacker', death_reward_preview: 0, hp: 100, x: 500, y: 0 },
  ] });
  // 掉血事件：子弹位置与自身位置对不上（无法确认攻击者）→ 不能再靠"最近玩家"兜底
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [{ owner_user_id: 3, x: 99999, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.state, 'RETALIATING', '受攻击但未确认攻击者时进入戒备态');
  assert.ok(bot.calls.shoot.length === 0, '子弹无法确认攻击者时不能乱开火，绝不能打 0 金币的旁观者 C');
  assert.equal(bot.retalTargetId, null, '不应锁定旁观者 C');
  // 关键：虽然不开火，但也必须横移躲子弹，不能站桩当靶子。
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.ok(lastVel && lastVel !== 'vel 0 0', '无法确认攻击者时仍应横移躲避，而非站桩');
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
  // 目标在 160m（出射程，需追击）
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
  assert.ok(bot.aggroIgnore && bot.aggroIgnore.id === 2, '应记录放弃冷却，避免重锁同一人');
});

test('aggro does NOT re-lock the same player during the give-up cooldown', () => {
  const bot = seedBotBridge();
  // 目标在射程内(5m) 且富 —— 但处于放弃冷却中，不应被重新锁定。
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.aggroIgnore = { id: 2, until: Date.now() + CONFIG.aggroGiveUpCooldownMs }; // 冷却中

  bot.tick();

  assert.equal(bot.aggroTargetId, null, '冷却期内不应重新锁定刚放弃的目标');
  assert.ok(bot.calls.shoot.length === 0, '冷却期内不应攻击该目标');
});

test('aggro CAN re-lock a different rich player during another player give-up cooldown', () => {
  const bot = seedBotBridge();
  // 2 号在冷却中，但 3 号是另一个富人 —— 应锁定 3 号。
  seedWorld(bot, { hp: 100, players: [
    { user_id: 2, name: 'A-cooldown', death_reward_preview: 50, hp: 100, x: 500, y: 0 },
    { user_id: 3, name: 'B-other', death_reward_preview: 30, hp: 100, x: 800, y: 0 },
  ] });
  bot.state = 'SCAVENGING';
  bot.aggroIgnore = { id: 2, until: Date.now() + CONFIG.aggroGiveUpCooldownMs };

  bot.tick();

  assert.equal(bot.aggroTargetId, 3, '应锁定冷却之外的另一名富人');
  assert.ok(bot.calls.shoot.length > 0, '应攻击 3 号');
});

test('aggro give-up cooldown expires and allows re-lock', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  // 冷却已过期
  bot.aggroIgnore = { id: 2, until: Date.now() - 1000 };

  bot.tick();

  assert.equal(bot.aggroTargetId, 2, '冷却过期后应能重新锁定');
  assert.ok(bot.calls.shoot.length > 0, '冷却过期后应恢复攻击');
});

test('teleport success clears pending rich drop and recovery flag', () => {
  const bot = seedBotBridge();
  bot.escapePhase = 'teleporting';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };
  bot.recoverAfterMissedDrop = true;
  bot.aggroIgnore = { id: 2, until: Date.now() + 10000 };

  bot.onTeleportAck(true);

  assert.equal(bot.pendingRichDrop, null, '传送成功应清空待拾取掉落');
  assert.equal(bot.recoverAfterMissedDrop, false, '传送成功应清空恢复标志');
  assert.equal(bot.aggroIgnore, null, '传送成功应清空放弃冷却');
});

test('leaveAndCooldown clears pending rich drop and recovery flag', () => {
  const bot = seedBotBridge();
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };
  bot.recoverAfterMissedDrop = true;
  bot.aggroTargetId = 2;
  bot.retalTargetId = 3;

  bot.leaveAndCooldown('测试');

  assert.equal(bot.pendingRichDrop, null, '下线应清空待拾取掉落');
  assert.equal(bot.recoverAfterMissedDrop, false, '下线应清空恢复标志');
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

test('strafeDirection is perpendicular to the self-target line', () => {
  // 目标在正东方：横移方向应为 (0,±1) 之一（垂直）
  const s = strafeDirection({ x: 0, y: 0 }, { x: 1000, y: 0 });
  assert.ok(Math.abs(s.dx) < 1e-9, 'dx 应≈0（垂直于连线）');
  assert.ok(Math.abs(Math.abs(s.dy) - 1) < 1e-9, 'dy 应≈±1');
});

test('tick keeps moving (strafe) while attacking in shoot range', () => {
  const bot = seedBotBridge();
  // 目标在射程内（5m）
  seedWorld(bot, { hp: 100, players: [{ user_id: 2, name: 'rich', death_reward_preview: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';

  bot.tick();

  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.shoot.length > 0, '应开火');
  // 射程内也要移动（横移躲子弹），不能是 vel 0 0 站桩
  assert.ok(bot.calls.vel.length > 0, '攻击中应保持移动（横移）');
  const lastVel = bot.calls.vel[bot.calls.vel.length - 1];
  assert.notEqual(lastVel, 'vel 0 0', '攻击中不应站桩不动');
});