// 策略模块：金币选择、就近风险、反击决策、传送与逃生判定。

import { CONFIG } from './config.js';
import { distance } from './state.js';

// 在满血前提下选择最安全的目标金币。
// 候选：当前可见、未过期。评分：距离更近更好，金币附近有玩家则降权。
export function chooseCoin(state) {
  if (!state.self) return null;
  const myPos = state.self;
  // 坐标单位为厘米(cm)，配置为米(m)，比较前统一换算成厘米
  const pickupCm = CONFIG.pickupRadiusM * CONFIG.cmPerMeter;
  const riskCm = CONFIG.playerRiskRadiusM * CONFIG.cmPerMeter;
  const chaseCm = CONFIG.maxChaseDistanceM * CONFIG.cmPerMeter;

  const nearPlayers = state.visiblePlayers().filter((p) => distance(p, myPos) < riskCm);

  let best = null;
  let bestScore = -Infinity;

  for (const coin of state.coinDrops.values()) {
    // 注意用 typeof 判断而不是 !coin.x —— 坐标可以合法地为 0
    if (typeof coin.x !== 'number' || typeof coin.y !== 'number') continue;
    const d = distance(myPos, coin);
    if (d < pickupCm) {
      // 已在脚下，直接拾取
      return { coin, distance: d };
    }
    // 太远的不追：视野外快照数据不可靠，且移动成本高
    if (d > chaseCm) continue;
    let score = -d;
    // 玩家邻接风险：有人在附近则大幅降权
    const threatened = nearPlayers.some((p) => distance(p, coin) < riskCm);
    if (threatened) score -= 100000;
    // 金币本身价值略加分
    score += (coin.amount ?? coin.value ?? 0) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = { coin, distance: d };
    }
  }
  return best;
}

// 判定"正在被攻击"的时间窗(毫秒)：最近这段时间内有掉血就算在被打。
const ATTACK_WINDOW_MS = 5000;

// 是否正在被攻击 —— 以最近是否掉血为准，比识别"是谁在打"更可靠。
export function isUnderAttack(state, windowMs = ATTACK_WINDOW_MS) {
  const events = state?.hpEvents;
  if (!Array.isArray(events) || events.length === 0) return false;
  const last = events[events.length - 1];
  return Date.now() - last.at <= windowMs;
}

// 是否应该逃生：HP 低于阈值【且】正在被攻击，两个条件都要满足。
//
// 为什么必须加"正在被攻击"：离开游戏并不会加快回血。若只看 HP，
// 低血重新加入时会立刻再次判定逃生 -> 又离开 -> 等 180s -> 回来血还是低 -> 再离开，
// 形成永远出不来的死循环。没人攻击时正确做法是留在原地回血。
//
// 例外：重连后附近已有人（蹲点）时，由 bot-bridge 的 rejoin 安全检查单独处理。
export function shouldEscape(state, windowMs = ATTACK_WINDOW_MS) {
  const self = state?.self;
  if (!self || typeof self.hp !== 'number') return false;
  if (self.hp >= CONFIG.escapeHp) return false;
  return isUnderAttack(state, windowMs);
}

// 反击决策：仅攻击已确认的当前攻击者。
// ctx：{ attacker } 由外在帧关联逻辑填充。若未确认攻击者则不动（规避而非乱射）。
export function chooseRetaliation(state, ctx = {}) {
  if (!state.self || !ctx.attacker) return null;
  const attacker = ctx.attacker;
  // 需要确认攻击者在射程且构成威胁
  if (distance(state.self, attacker) > 150 * CONFIG.cmPerMeter) return null; // 150m 射程
  return attacker;
}

// 找出距离最近的玩家及其距离；没有可见玩家时返回 null。
export function nearestPlayer(state) {
  const self = state?.self;
  if (!self || typeof self.x !== 'number') return null;
  let best = null;
  let bestD = Infinity;
  for (const p of state.visiblePlayers()) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    const d = distance(self, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { player: best, distance: bestD } : null;
}

// 是否该进入规避：HP 低于阈值，且有玩家逼近到触发距离内。
// 与 shouldEscape 的分工：
//   - 已经挨打(shouldEscape)  -> 直接下线，说明躲不掉了
//   - 只是有人逼近(本函数)    -> 先拉开距离，别急着付 180 秒下线代价
export function shouldEvade(state, triggerM = CONFIG.evadeTriggerDistanceM) {
  const self = state?.self;
  if (!self || typeof self.hp !== 'number') return false;
  if (self.hp >= CONFIG.escapeHp) return false;
  const near = nearestPlayer(state);
  // 配置为米，坐标差为厘米
  return !!near && near.distance <= triggerM * CONFIG.cmPerMeter;
}

// 逃跑方向：单纯地远离该威胁(归一化向量)。
// 不做"往地图中心偏"的修正 —— 服务器坐标单位与原点尚未确认，
// 贸然按假想中心偏移可能把自己往危险方向带。撞边界的情况由"卡住检测"兜底。
export function fleeDirection(self, threat) {
  const dx = self.x - threat.x;
  const dy = self.y - threat.y;
  const len = Math.hypot(dx, dy);
  // 完全重合时给一个确定方向，避免 0/0
  if (len < 1e-6) return { dx: 1, dy: 0 };
  return { dx: dx / len, dy: dy / len };
}

// 统一的金币读取：不同消息/版本可能用 gold / amount / coins 之一，全部兜底。
export function getPlayerGold(entity) {
  const v = entity?.gold ?? entity?.amount ?? entity?.coins;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// 主动攻击：金币 > 3 且在自己圆心 aggroRadiusCm 范围内的玩家。
// 多个候选时优先攻击"金币最多的"，同金则取最近（富的优先，避免只打头皮）。
// 注意：visiblePlayers() 已排除自身；这里再排除死亡玩家与坐标缺失。
export function chooseAggroTarget(state) {
  if (!state.self) return null;

  const myPos = state.self;
  const radius = CONFIG.aggroRadiusCm;
  const minGold = CONFIG.aggroMinGold;

  let best = null;
  let bestScore = -Infinity;

  for (const p of state.visiblePlayers()) {
    // 坐标缺失或已死亡的目标不攻击
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (typeof p.hp === 'number' && p.hp <= 0) continue;

    const d = distance(myPos, p);
    // 出圈的不攻击；完全重合(距离≈0)跳过，防自己/防 0/0
    if (d > radius || d < 1e-6) continue;

    const gold = getPlayerGold(p);
    if (gold <= minGold) continue;

    const score = gold * 1000 - d; // 富者优先，同富时近者优先
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

// 附近玩家中，返回距离自身最近的玩家实体（由调用方用弹道/HP 下降关联增强威胁判定）。
export function nearestThreat(state) {
  if (!state.self) return null;
  let nearest = null;
  let best = Infinity;
  for (const p of state.visiblePlayers()) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    const d = distance(state.self, p);
    if (d < best) {
      best = d;
      nearest = p;
    }
  }
  return nearest;
}

// 生成远离攻击者的随机传送坐标（厘米）。
// 要求：离开攻击者至少 minM，且尽量远离所有可见玩家。
export function chooseRandomEscapePosition(state, attacker = null) {
  const self = state?.self;
  if (!self || typeof self.x !== 'number' || typeof self.y !== 'number') return null;

  const minM = CONFIG.randomTeleportMinM ?? 400;
  const maxM = CONFIG.randomTeleportMaxM ?? 1800;
  const minCm = minM * CONFIG.cmPerMeter;
  const maxCm = maxM * CONFIG.cmPerMeter;
  const threat = attacker || nearestThreat(state) || self;
  const players = state.visiblePlayers?.() || [];

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < 48; i++) {
    // 优先朝远离威胁的半圆随机，再叠加角度噪声
    const base = fleeDirection(self, threat);
    const noise = (Math.random() - 0.5) * Math.PI; // ±90°
    const ang = Math.atan2(base.dy, base.dx) + noise;
    const dist = minCm + Math.random() * (maxCm - minCm);
    const x = self.x + Math.cos(ang) * dist;
    const y = self.y + Math.sin(ang) * dist;

    const dThreat = distance({ x, y }, threat);
    if (dThreat < minCm) continue;

    // 与所有可见玩家的最小距离越大越好
    let minPlayer = dThreat;
    for (const p of players) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      minPlayer = Math.min(minPlayer, distance({ x, y }, p));
    }
    const score = minPlayer - dist * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = [x, y];
    }
  }

  if (best) return best;

  // fallback：沿远离威胁方向推 minCm
  const dir = fleeDirection(self, threat);
  return [self.x + dir.dx * minCm, self.y + dir.dy * minCm];
}
