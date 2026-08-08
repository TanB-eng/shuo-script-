import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeBot } from '../src/bot-bridge.js';
import { shouldEscape } from '../src/strategy.js';

test('full HP scavenges even when 1h stamina is below the old reserve', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  bot.state = 'SCAVENGING';
  bot.world.self = {
    user_id: 1,
    hp: 100,
    max_hp: 100,
    x: 0,
    y: 0,
    stamina_1h_remaining_milli: 692000,
  };
  bot.world.coinDrops.set('coin', { id: 'coin', x: 1000, y: 0 });

  bot.tick();

  assert.equal(bot.state, 'SCAVENGING');
  assert.match(bot.stateMsg, /前往金币|拾取中/);
});

test('successful teleport forgets old damage but reacts to new damage', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.escapePhase = 'teleporting';
  bot.world.self = { user_id: 1, hp: 80, max_hp: 100, x: 0, y: 0 };
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  assert.equal(shouldEscape(bot.world), true);

  bot.onTeleportAck(true);

  assert.equal(shouldEscape(bot.world), false);
  bot.world.hpEvents.push({ at: Date.now(), self: { x: 0, y: 0 }, bullets: [] });
  assert.equal(shouldEscape(bot.world), true);
});

test('nearby player after reconnect does not cause logout without a new attack', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.world.self = { user_id: 1, hp: 88, max_hp: 100, x: 0, y: 0 };
  bot.world.entities.set(2, { user_id: 2, name: 'nearby', hp: 100, x: 5500, y: 0 });
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();

  assert.equal(left, false);
  assert.equal(bot.state, 'WAITING_FOR_FULL_HP');
  assert.match(bot.stateMsg, /原地回血|等待满血/);
});

test('fresh pos updates prevent stale snapshot false positive', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.world.self = { user_id: 1, hp: 100, max_hp: 100, x: 0, y: 0 };
  bot.world.lastSnapshotAt = Date.now() - 120_000;
  bot.world.lastPosAt = Date.now();
  bot.world.coinDrops.set('coin', { id: 'coin', x: 1000, y: 0 });

  bot.tick();

  assert.equal(bot.state, 'SCAVENGING');
  assert.match(bot.stateMsg, /前往金币|拾取中/);
});

test('world reset clears stale activity timestamps before rejoin', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.world.lastSnapshotAt = Date.now() - 90_000;
  bot.world.lastPosAt = Date.now() - 90_000;

  bot.world.reset();

  assert.equal(bot.world.lastSnapshotAt, 0);
  assert.equal(bot.world.lastPosAt, 0);
});

test('binding user id adopts state received before hello', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.world.applyWsMessage({
    type: 'pos',
    entities: [{ user_id: 1, hp: 88, max_hp: 100, x: 10, y: 20 }],
  });

  bot.world.setSelf(1);

  assert.equal(bot.world.self.hp, 88);
  assert.equal(bot.world.self.x, 10);
});

test('missing self state after hello triggers protective logout', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  bot.state = 'WAITING_FOR_FULL_HP';
  bot.world.self = { user_id: 1 };
  bot.selfSyncStartedAt = Date.now() - 3_100;
  let reason = '';
  bot.leaveAndCooldown = (value) => { reason = value; };

  bot.tick();

  assert.match(reason, /自身状态同步超时/);
});

function setupAttackedBot(hp, canTeleport) {
  const commands = [];
  let teleportChecks = 0;
  const bot = new BridgeBot({ observeOnly: false });
  bot.bridge = {
    isConnected: () => true,
    send: (command) => { commands.push(command); return true; },
  };
  bot.state = 'SCAVENGING';
  bot.world.self = { user_id: 1, hp, max_hp: 100, x: 0, y: 0 };
  bot.world.entities.set(2, { user_id: 2, name: 'attacker', hp: 100, x: 1000, y: 0 });
  bot.world.hpEvents.push({
    at: Date.now(),
    self: { x: 0, y: 0 },
    bullets: [{ owner_user_id: 2, x: 0, y: 0 }],
  });
  bot.world.canTeleport = () => {
    teleportChecks += 1;
    return canTeleport;
  };
  bot.pickEscapeTarget = () => ({ pos: [5000, 5000], label: 'test' });
  return { bot, commands, getTeleportChecks: () => teleportChecks };
}

test('high HP attack retaliates directly (no teleport before retaliation)', () => {
  const { bot, commands } = setupAttackedBot(95, true);

  bot.tick();

  // 用户规则：有人攻击我，不管金币数量都反击；只有 HP<85 才走下线/转移。
  assert.ok(commands.some((command) => command.startsWith('shoot ')));
  assert.equal(commands.some((command) => command.startsWith('tp ')), false);
  bot.onTeleportAck(true);
});

test('high HP attack retaliates when teleport is unavailable', () => {
  const { bot, commands, getTeleportChecks } = setupAttackedBot(95, false);
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();

  assert.equal(left, false);
  assert.ok(commands.some((command) => command.startsWith('shoot ')));
});

test('low HP attack still logs out when teleport is unavailable', () => {
  const { bot, commands } = setupAttackedBot(80, false);
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();

  assert.equal(left, true);
  assert.equal(commands.some((command) => command.startsWith('shoot ')), false);
});

test('dropping below escape HP while teleporting changes failure fallback to logout', () => {
  const { bot, commands } = setupAttackedBot(95, true);
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();
  bot.world.self.hp = 80;
  bot.tick();
  bot.onTeleportAck(false, 'blocked');

  // 掉到 HP<85 后进入逃生模式（传送），失败后应下线而不是反击。
  assert.equal(left, true);
});

test('low HP emergency teleport remains logout mode if HP recovers before failure', () => {
  const { bot, commands } = setupAttackedBot(80, true);
  let left = false;
  bot.leaveAndCooldown = () => { left = true; };

  bot.tick();
  bot.world.self.hp = 95;
  bot.tick();
  bot.onTeleportAck(false, 'blocked');

  // 低血逃生已锁定为 logout：即使 HP 恢复，传送失败仍应下线（不因"已恢复"改成反击）。
  assert.equal(left, true);
});
