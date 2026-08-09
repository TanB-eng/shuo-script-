// 逃生/离开后的离线冷却。持久化截止时间，进程重启后不得提前重连。

import { loadRunstate, saveRunstate } from './config.js';
import { CONFIG } from './config.js';

// 记录一次离开，写入冷却截止的 epoch 毫秒。
export function markOfflineCooldown(durationSec) {
  const untilEpochMs = Date.now() + durationSec * 1000;
  saveRunstate((s) => ({
    ...s,
    offlineCooldownUntilEpochMs: untilEpochMs,
  }));
  return untilEpochMs;
}

// 距冷却结束还需等待的毫秒数；若时间到或从未设置则返回 0。
export function remainingCooldownMs() {
  const rs = loadRunstate();
  const until = rs.offlineCooldownUntilEpochMs;
  if (!until) return 0;
  const rem = until - Date.now();
  return rem > 0 ? rem : 0;
}

// 清除冷却（供测试/重新加入用）。
export function clearOfflineCooldown() {
  saveRunstate((s) => ({ ...s, offlineCooldownUntilEpochMs: 0 }));
}

// ---- 递增冷却 ----

// 档位 -> 冷却秒数：基础 90s，每档 +30s，封顶 5 分钟(300s)。
// 档位含义 = "第几次逃生"。tier=1 -> 90s，tier=2 -> 120s，tier=3 -> 150s … tier=8 -> 300s。
export function cooldownSecForTier(tier) {
  const cap = CONFIG.offlineCooldownCapSec ?? 300;
  const step = CONFIG.offlineCooldownStepSec ?? 30;
  const base = CONFIG.offlineCooldownSec ?? 90;
  if (tier <= 1) return base;
  return Math.min(base + step * (tier - 1), cap);
}

// 档位上界：再往上加也是封顶秒数，不必无限增长。
function maxTierFor() {
  const cap = CONFIG.offlineCooldownCapSec ?? 300;
  const step = CONFIG.offlineCooldownStepSec ?? 30;
  const base = CONFIG.offlineCooldownSec ?? 90;
  if (step <= 0) return 1;
  return Math.max(1, Math.floor((cap - base) / step) + 1);
}
const MAX_TIER = maxTierFor();

// 逃生一次：把离线冷却"加一档"并落到 runstate。
// 返回 { tier, sec }：本次要等的秒数与此档位号（供日志/测试）。
export function escalateOfflineCooldown() {
  const rs = loadRunstate();
  const cur = rs.offlineCooldownTier ?? 0;
  const tier = Math.min(cur + 1, MAX_TIER);
  const sec = cooldownSecForTier(tier);
  saveRunstate((s) => ({
    ...s,
    offlineCooldownTier: tier,
    offlineCooldownUntilEpochMs: Date.now() + sec * 1000,
  }));
  return { tier, sec };
}

// 逃生成功(满血恢复)或传送成功时，把档位清零 -> 下次逃生回到基础 90s。
export function resetOfflineCooldownTier() {
  saveRunstate((s) => ({ ...s, offlineCooldownTier: 0 }));
}

// 当前档位（未逃过 -> 0）。
export function currentOfflineTier() {
  const rs = loadRunstate();
  return rs.offlineCooldownTier ?? 0;
}