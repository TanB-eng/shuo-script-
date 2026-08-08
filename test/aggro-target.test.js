import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeBot } from '../src/bot-bridge.js';
import { chooseAggroTarget, getPlayerGold } from '../src/strategy.js';

// 构造一个观察模式(不发真实指令)的桥接 bot，并用 stub 记录 emit 调用。
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

test('getPlayerGold falls back across gold/amount/coins fields', () => {
  assert.equal(getPlayerGold({ gold: 5 }), 5);
  assert.equal(getPlayerGold({ amount: 7 }), 7);
  assert.equal(getPlayerGold({ coins: 9 }), 9);
  assert.equal(getPlayerGold({}), 0);
  assert.equal(getPlayerGold({ gold: 'abc' }), 0);
});

test('chooseAggroTarget picks richest rich player in radius, skips out-of-range/insufficient', () => {
  const bot = new BridgeBot({ observeOnly: true });
  seedWorld(bot, {
    players: [
      { user_id: 2, gold: 4, hp: 100, x: 500, y: 0 },      // 富者，圈内
      { user_id: 3, gold: 2, hp: 100, x: 300, y: 0 },      // 金币不足 3
      { user_id: 4, gold: 100, hp: 100, x: 999999, y: 0 }, // 圈外（999999cm）
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
      { user_id: 2, gold: 50, hp: 0, x: 500, y: 0 }, // 已死
      { user_id: 3, gold: 50, hp: 100 },              // 无坐标
    ],
  });
  assert.equal(chooseAggroTarget(bot.world), null);
});

test('tick actively attacks rich player in radius at HP>=escapeHp even if not full HP', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 90, players: [{ user_id: 2, name: 'rich', gold: 10, hp: 100, x: 500, y: 0 }] });
  bot.state = 'SCAVENGING';
  bot.lastAggroAt = 0;

  bot.tick();

  assert.equal(bot.state, 'RETALIATING');
  assert.ok(bot.calls.shoot.length > 0, '应开火攻击高金币玩家');
  assert.ok(bot.pendingRichDrop, '应记录掉落坐标');
  assert.equal(bot.pendingRichDrop.x, 500);
  assert.equal(bot.pendingRichDrop.y, 0);
});

test('tick does not aggro when HP < escapeHp (85)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 84, players: [{ user_id: 2, name: 'rich', gold: 500, hp: 100, x: 500, y: 0 }] });
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] }); // 正在被打
  bot.state = 'SCAVENGING';
  bot.escape = () => {}; // 短路逃生，只验证"不应主动攻击"

  bot.tick();

  assert.notEqual(bot.state, 'RETALIATING', 'HP<85 不能进入攻击状态');
  assert.ok(bot.calls.shoot.length === 0, 'HP<85 不应主动开火');
});

test('kill -> drop appears -> bot walks to pick it up (not-full-HP exemption)', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 70, coins: [{ id: 'drop', x: 500, y: 0, amount: 50 }] });
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.pendingRichDrop = { x: 500, y: 0, at: Date.now() };
  const velBefore = bot.calls.vel.length;

  bot.tick();

  assert.ok(bot.calls.vel.length > velBefore, '应向掉落移动（未满血也要先拾取）');
  assert.ok(bot.pendingRichDrop, '尚未到达，掉落记录保留（未拾取完成不清空）');
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

test('drop pickup timeout sets recoverAfterMissedDrop and waits for full HP', () => {
  const bot = seedBotBridge();
  seedWorld(bot, { hp: 60, coins: [] }); // 地图上没有任何金币
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