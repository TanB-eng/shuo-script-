// 逃生/离开后的离线冷却。使用单调时钟 + 持久化截止时间，进程重启后不得提前重连。

import { loadRunstate, saveRunstate } from './config.js';

// 记录一次离开，写入冷却截止的 epoch 毫秒。
export function markOfflineCooldown(durationSec) {
  const untilEpochMs = Date.now() + durationSec * 1000;
  saveRunstate((s) => ({ ...s, offlineCooldownUntilEpochMs: untilEpochMs }));
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