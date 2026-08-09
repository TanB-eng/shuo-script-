import test from 'node:test';
import assert from 'node:assert/strict';
// 先加载环境，把落盘指到临时目录（必须在导入 src 之前）。
import './cooldown-test-env.js';
import {
  cooldownSecForTier, escalateOfflineCooldown, resetOfflineCooldownTier,
  currentOfflineTier, remainingCooldownMs, clearOfflineCooldown,
} from '../src/cooldown.js';
import { BridgeBot } from '../src/bot-bridge.js';
import { CONFIG } from '../src/config.js';
import { loadRunstate } from '../src/config.js';

// 递增冷却的语义（用户规则）：
//   第 1 次下线 90s，第 2 次 120s，第 3 次 150s ... 每档 +30s，封顶 5 分钟(300s)。
//   成功回满血 -> 档位清零 -> 下次又是 90s。

test('cooldownSecForTier maps tier to escalating seconds, capped at 5min', () => {
  assert.equal(cooldownSecForTier(0), 90, 'tier=0（未逃过）→ 基础 90s');
  assert.equal(cooldownSecForTier(1), 90, '第 1 次 → 90s');
  assert.equal(cooldownSecForTier(2), 120, '第 2 次 → 120s');
  assert.equal(cooldownSecForTier(3), 150, '第 3 次 → 150s');
  assert.equal(cooldownSecForTier(4), 180, '第 4 次 → 180s');
  assert.equal(cooldownSecForTier(7), 270, '第 7 次 → 270s');
  assert.equal(cooldownSecForTier(8), 300, '第 8 次 → 300s（封顶）');
  assert.equal(cooldownSecForTier(9), 300, '第 9 次 → 仍 300s（封顶）');
  assert.equal(cooldownSecForTier(99), 300, '再多次都停在封顶 300s，不再无限增长');
});

test('escalateOfflineCooldown builds 90 -> 120 -> 150 and caps at 300', () => {
  resetOfflineCooldownTier(); // 干净起点
  const e1 = escalateOfflineCooldown();
  assert.deepEqual({ tier: e1.tier, sec: e1.sec }, { tier: 1, sec: 90 }, '第 1 次 90s');

  const e2 = escalateOfflineCooldown();
  assert.deepEqual({ tier: e2.tier, sec: e2.sec }, { tier: 2, sec: 120 }, '第 2 次 120s');

  const e3 = escalateOfflineCooldown();
  assert.deepEqual({ tier: e3.tier, sec: e3.sec }, { tier: 3, sec: 150 }, '第 3 次 150s');
});

test('escalation stays capped at 300s after reaching the ceiling', () => {
  resetOfflineCooldownTier();
  // 一路逃到封顶（第 8 档 -> 300s）
  for (let i = 0; i < 20; i++) escalateOfflineCooldown();
  const after = escalateOfflineCooldown();
  assert.equal(after.sec, 300, '超过封顶后仍为 300s');
  assert.equal(after.tier, CooldownMaxTierExpected(), '档位不再增长');
});

test('remainingCooldownMs reflects the escalated duration', () => {
  resetOfflineCooldownTier();
  escalateOfflineCooldown(); // tier=1 -> 90s
  const rem = remainingCooldownMs();
  assert.ok(rem > 0 && rem <= 90_000, `应有 90s 冷却剩余，实测 ${rem}`);

  // "时间流逝"后再看：仍为正数（未过期）
  const remLater = remainingCooldownMs();
  assert.ok(remLater <= rem, '剩余时间应随时间减少');
});

test('resetOfflineCooldownTier returns the next escape to 90s', () => {
  resetOfflineCooldownTier();
  escalateOfflineCooldown(); // -> 第1档 90s
  escalateOfflineCooldown(); // -> 第2档 120s
  assert.equal(currentOfflineTier(), 2);
  assert.equal(cooldownSecForTier(currentOfflineTier() + 1), 150, '当前第2档，再逃一次是第3档=150s');

  resetOfflineCooldownTier();
  assert.equal(currentOfflineTier(), 0, '档位清零');
  const next = escalateOfflineCooldown();
  assert.deepEqual({ tier: next.tier, sec: next.sec }, { tier: 1, sec: 90 }, '清零后再逃回到 90s');
});

test('escalation persists across process restarts (runstate on disk)', () => {
  resetOfflineCooldownTier();
  escalateOfflineCooldown();
  escalateOfflineCooldown(); // 第2档
  // "重启后"再读：档位仍在 runstate 文件里
  assert.equal(loadRunstate().offlineCooldownTier, 2, '档位应持久化');
  assert.equal(currentOfflineTier(), 2);
});

// ---- 与 BridgeBot.leaveAndCooldown 的接线 ----

function makeBot() {
  const bot = new BridgeBot({ observeOnly: true });
  bot.bridge = { isConnected: () => true, send: () => {}, close: () => {} };
  // 屏蔽网络发送(测试不真发指令)
  bot.emit = () => true;
  bot.stopMoving = () => {};
  return bot;
}

test('leaveAndCooldown({escalate:true}) sets escalating cooldown and flags relocation', () => {
  resetOfflineCooldownTier();
  const bot = makeBot();
  bot.world.self = { user_id: 1, hp: 70, x: 0, y: 0, max_hp: 100 };
  bot.world.entities.set(2, { user_id: 2, name: 'a', hp: 100, x: 5000, y: 0 });
  // 触发 escapeThreat 的记录：nearestPlayer 会找到玩家 2
  bot.leaveAndCooldown('测试逃生', { escalate: true });

  assert.equal(bot._pendingRelocate, true, '逃生下线应标记落地转移');
  assert.equal(bot._relocateTarget, null, '回此前还没选定目标点');
  assert.ok(bot._escapeThreat, '应记录逃前威胁位置');
  assert.equal(remainingCooldownMs() > 0, true, '应写入递增冷却');
});

test('leaveAndCooldown without escalate (technical) stays at base 90s and no relocation', () => {
  resetOfflineCooldownTier();
  const bot = makeBot();
  bot.leaveAndCooldown('自身状态同步超时'); // 未传 opts -> 不递增
  assert.equal(bot._pendingRelocate, false, '技术性下线不应标记落地转移');
  assert.equal(bot._escapeThreat, null, '技术性下线不应记录威胁');
  const rem = remainingCooldownMs();
  assert.ok(rem > 0 && rem <= 90_000, `技术性下线应为基础 90s，实测 ${rem}`);
});

test('onTeleportAck success clears relocation flag and resets the tier', () => {
  resetOfflineCooldownTier();
  const bot = makeBot();
  bot._pendingRelocate = true;
  bot._relocateTarget = { x: 9999, y: 9999 };
  bot._escapeThreat = { x: 0, y: 0 };
  escalateOfflineCooldown(); // 把一个档位写进 runstate
  assert.equal(currentOfflineTier(), 1);

  bot.escapePhase = 'teleporting';
  bot.onTeleportAck(true);

  assert.equal(bot._pendingRelocate, false, '传送成功应清除落地转移');
  assert.equal(bot._escapeThreat, null, '传送成功应清除威胁');
  assert.equal(currentOfflineTier(), 0, '传送成功应清零递增强位');
});

// 预期的封顶档位数（与实现一致：base 90 每档+30 到 cap 300 => 第 8 档封顶）
function CooldownMaxTierExpected() {
  const { offlineCooldownSec, offlineCooldownStepSec, offlineCooldownCapSec } = CONFIG;
  return Math.max(1, Math.floor((offlineCooldownCapSec - offlineCooldownSec) / offlineCooldownStepSec) + 1);
}
clearOfflineCooldown(); // 收尾清掉写盘状态，避免污染后续