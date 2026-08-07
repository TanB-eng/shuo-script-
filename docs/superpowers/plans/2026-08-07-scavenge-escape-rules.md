# Scavenge and Escape Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full HP the only Bot-side prerequisite for scavenging and ensure a successful teleport discards pre-teleport attack evidence.

**Architecture:** Add Node built-in tests around the existing `BridgeBot` state machine. Make `src/bot-bridge.js` safe to import in tests, remove the stamina-reserve gate from its tick loop, and clear `WorldState` attack history after a successful teleport acknowledgment.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing bridge Bot modules

---

### Task 1: Add failing behavior tests

**Files:**
- Create: `test/bot-bridge-rules.test.js`
- Modify: `package.json`
- Modify: `src/bot-bridge.js`

- [ ] **Step 1: Make `BridgeBot` importable without starting the CLI**

Wrap the bottom-level Bot construction, signal handlers, and `--test-leave` handling in a direct-execution guard based on `fileURLToPath(import.meta.url)` and `resolve(process.argv[1])`. Running `node src/bot-bridge.js` must behave as before; importing the module must not open ports or timers.

- [ ] **Step 2: Add the Node test command**

Add this script to `package.json`:

```json
"test": "node --test"
```

- [ ] **Step 3: Write tests for both requested rules**

Create `test/bot-bridge-rules.test.js` with tests that:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeBot } from '../src/bot-bridge.js';
import { shouldEscape } from '../src/strategy.js';

test('full HP scavenges even when 1h stamina is below the old reserve', () => {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => true };
  bot.state = 'WAITING_FOR_FULL_HP';
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
```

- [ ] **Step 4: Run tests and verify RED**

Run: `npm test`

Expected: the low-stamina test remains in `WAITING_FOR_FULL_HP` with a stamina-protection message, and the teleport test still sees the old attack event.

### Task 2: Implement the minimum behavior changes

**Files:**
- Modify: `src/bot-bridge.js`
- Modify: `src/state.js`

- [ ] **Step 1: Remove the stamina-reserve gate**

Delete the `hasStaminaToScavenge(CONFIG.staminaReserveMillis)` block from `BridgeBot.tick()`. Keep the existing full-HP check immediately before scavenging.

- [ ] **Step 2: Add and use attack-history clearing**

Add this method to `WorldState`:

```javascript
clearAttackHistory() {
  this.hpEvents.length = 0;
}
```

Call `this.world.clearAttackHistory()` inside the successful branch of `BridgeBot.onTeleportAck()` before switching to `WAITING_FOR_FULL_HP`. Reset `escapeAttempts` because a later, genuinely new attack begins a new escape sequence.

- [ ] **Step 3: Run tests and verify GREEN**

Run: `npm test`

Expected: 2 tests pass, 0 fail.

### Task 3: Verify without disturbing user changes

**Files:**
- Verify: `src/bot-bridge.js`
- Verify: `src/state.js`
- Verify: `src/strategy.js`
- Verify: `userscript/grasp-rat-bridge.user.js`

- [ ] **Step 1: Run focused syntax checks**

```powershell
node --check src/bot-bridge.js
node --check src/state.js
node --check src/strategy.js
node --check userscript/grasp-rat-bridge.user.js
```

Expected: all commands exit successfully.

- [ ] **Step 2: Review the exact diff**

Run `git diff -- package.json test/bot-bridge-rules.test.js src/bot-bridge.js src/state.js` and confirm every new line maps to the two requested rules or testability.

- [ ] **Step 3: Do not stage unrelated work**

Leave the user's existing modifications to `README.md`, `src/config.js`, `src/cooldown.js`, `src/strategy.js`, `userscript/grasp-rat-bridge.user.js`, and `启动无节流浏览器.bat` untouched and unstaged.
