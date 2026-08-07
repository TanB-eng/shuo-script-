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
