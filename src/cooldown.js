// 逃生/离开后的离线冷却。使用单调时钟 + 持久化截止时间，进程重启后不得提前重连。
// 支持蹲点死亡循环防护：连续因附近有人再下线时，冷却按倍数递增。

import { loadRunstate, saveRunstate, CONFIG } from './config.js';

// 记录一次离开，写入冷却截止的 epoch 毫秒。
// escalate=true 时：streak+1，冷却 = base * escalation^streak，并封顶。
export function markOfflineCooldown(durationSec, { escalate = false } = {}) {
  const base = durationSec ?? CONFIG.offlineCooldownSec;
  const escalation = CONFIG.offlineCooldownEscalation ?? 2;
  const maxSec = CONFIG.offlineCooldownMaxSec ?? 900;

  let streak = 0;
  let actualSec = base;
  if (escalate) {
    const rs = loadRunstate();
    streak = (rs.campStreak || 0) + 1;
    actualSec = Math.min(maxSec, Math.round(base * Math.pow(escalation, streak - 1)));
  }

  const untilEpochMs = Date.now() + actualSec * 1000;
  saveRunstate((s) => ({
    ...s,
    offlineCooldownUntilEpochMs: untilEpochMs,
    campStreak: escalate ? streak : (s.campStreak || 0),
    lastCooldownSec: actualSec,
  }));
  return { untilEpochMs, actualSec, streak: escalate ? streak : 0 };
}

// 距冷却结束还需等待的毫秒数；若时间到或从未设置则返回 0。
export function remainingCooldownMs() {
  const rs = loadRunstate();
  const until = rs.offlineCooldownUntilEpochMs;
  if (!until) return 0;
  const rem = until - Date.now();
  return rem > 0 ? rem : 0;
}

// 读当前蹲点连续次数。
export function getCampStreak() {
  return loadRunstate().campStreak || 0;
}

// 读最近一次实际冷却秒数。
export function getLastCooldownSec() {
  return loadRunstate().lastCooldownSec || CONFIG.offlineCooldownSec;
}

// 成功安全恢复（满血并开始拾金）后清零蹲点计数。
export function clearCampStreak() {
  saveRunstate((s) => ({ ...s, campStreak: 0 }));
}

// 清除冷却（供测试/重新加入用）。
export function clearOfflineCooldown() {
  saveRunstate((s) => ({ ...s, offlineCooldownUntilEpochMs: 0 }));
}