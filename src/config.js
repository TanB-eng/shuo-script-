// 配置模块。敏感项（凭据、运行状态）一律从本地文件读取，不入库。
// 协议地址、消息类型、频率限制来自协议分析，不在此手工猜测。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------- 固定配置（来自协议实测） ----------------
export const PROTOCOL = {
  // 服务器默认这些值（见 spec 协议附录）
  staminaLimitsMillis: {
    s5: 10000,
    h1: 3000000,
    d1: 20000000,
  },
  // 传送消耗 1h/1d 窗口的毫秒数
  teleportNeedMillis: 1500 * 1000,
};

// ---------------- 用户级配置（可被本地 config.json 覆盖） ----------------
const DEFAULTS = {
  baseUrl: 'https://grasp-rat-game.h-e.top',
  // HP 逃生阈值。用户决定：血量低于 85 就下线逃生。
  // 注意：伤害数值存在版本分歧（宣传图 -25 / 教程 -3），
  // 上线观察阶段须先实测 hp 下降速率再校准，不要按宣传图假定。
  escapeHp: 85,
  // 离线等待时间（秒）。用户决定从 180 改为 90，下线后等 90 秒自动重连。
  offlineCooldownSec: 90,
  // 加入等待自身实体出现的超时（毫秒）
  joinTimeoutMs: 20000,
  // 安全传送坐标，如 [1000, 2000]；不配置则逃生时直接离开
  safeTeleport: null, // [x, y]
  safeTeleportName: null, // 可选：按玩家名/名字搜索
  logLevel: 'info',
  // 观察模式：只接收不发送任何游戏动作
  observeOnly: false,
  // 拾取停止半径（米）。实测：15m 太远(12m就停)；0.8m/2m 都因整数8方向够不着。
  // 用户决定：1m 内才算"拾取中"。
  pickupRadiusM: 1,
  // 金币选择时忽略更近但旁边有玩家的金币的玩家邻接半径
  playerRiskRadiusM: 60,
  // 最大追逐距离(米)。超过就不追 —— 500m 外是后端快照数据，可靠性低。
  // 注意目标每 200ms 重新评估，途中出现更近金币会自动改道，所以不是"闭眼狂奔"。
  // 2000m ≈ 3.3 分钟 ≈ 200 点体力。
  maxChaseDistanceM: 2000,

  // ---- 规避(HP 低但还没挨打时，拉开距离而不是直接下线) ----
  // 触发距离(米)：HP<escapeHp 时，有玩家进入此距离就开始远离。
  // 取 250m 而非射程 150m —— 150m 是双向的，等他进射程时你也已在他射程内，
  // 往往已经吃到几发。250m 留出 100m 缓冲，在对方能开火前就开始拉开。
  evadeTriggerDistanceM: 250,
  // 解除距离(米)：威胁被拉开到此距离外就停下回血，不再白烧体力。
  // 必须大于触发距离，避免在边界反复抖动(跑一步就停、停一下又跑)。
  evadeSafeDistanceM: 350,
  // 规避时判定"撞墙卡住"的位移阈值与时间窗：
  // 若持续朝一个方向跑却几乎没位移(如顶到地图边界)，说明跑不动了，直接下线。
  // 注意：被威胁贴脸挡住/夹击时位移也会很小，所以窗口放宽到 8s、阈值降到 10m，
  // 避免在规避刚起步(方向还没跑开)时就误判撞墙、错误下线。
  evadeStuckWindowMs: 8000,
  evadeStuckMinMoveM: 10,
  aggroMinGold: 3,
  aggroRadiusCm: 10931,   // 以自己位置为圆心，10931cm（109.31米）内的玩家且金币>3就主动攻击
  // 主动攻击连发节流由 shoot 自带 100ms 控制（≈服务器上限 10发/秒），不再额外冷却。
  // 保留此配置仅为兼容历史 config.json，不再参与锁定目标的攻击路径。
  aggroCooldownMs: 800,
  // 追击超时（毫秒）：目标离开射程后追着打，90 秒内没打死就放弃这个人。
  aggroChaseTimeoutMs: 90000,
  // 高金币掉落等待超时（毫秒）：打死目标 30 秒内没出现可拾取金币就放弃，防止原地发呆。
  richDropPendingTimeoutMs: 30000,

  // ---- 单位换算：服务器坐标 = 厘米(cm)，不是米 ----
  // 铁证：客户端源码 WORLD_RADIUS_CM = 1000000(10000m 地图)、速度 speedCmPerSec。
  // 所有"米"制距离都要 ×100 再和坐标相减。下列后缀 _m 的配置，实际换算时由代码统一处理。

  // ---- 常用换算因子 ----
  cmPerMeter: 100,


  // 体力保护线(毫秒)。1h 窗口低于此值就停止拾金，保住传送逃生能力。
  // 账本：移动 10m 耗 1 点、速度 10m/s => 每秒烧 1 点；1h 窗口 3000 点 = 50 分钟连续移动。
  // 传送要 1500 点。若把体力烧光，遇袭时既跑不动也传送不了，只能站着被打死并掉光金币，
  // 这违背"生存最高优先级"。故留 1800 点余量(1500 传送 + 300 机动)。
  staminaReserveMillis: 1800 * 1000,
};

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// 本地 config.json（可选覆盖；不入库）
const localCfg = loadJson(join(ROOT, 'config.json')) ?? {};

export const CONFIG = { ...DEFAULTS, ...localCfg };

// ---------------- 凭据与运行状态（只写本地，不入库） ----------------
const DATA_DIR = join(ROOT, CONFIG.dataDir || '.data');
// 会话凭据：{ userId, token }
export const SESSION_FILE = join(DATA_DIR, 'session.json');
// 运行状态：{ offlineCooldownUntilEpochMs } —— 进程重启后防提前重连
export const RUNSTATE_FILE = join(DATA_DIR, 'runstate.json');

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSession() {
  return loadJson(SESSION_FILE);
}

export function saveSession(session) {
  ensureDataDir();
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function clearSession() {
  try {
    import('node:fs').then(({ unlinkSync }) => unlinkSync(SESSION_FILE));
  } catch {
    /* 无文件则忽略 */
  }
}

export function loadRunstate() {
  return loadJson(RUNSTATE_FILE) ?? {};
}

export function saveRunstate(mutator) {
  ensureDataDir();
  const cur = loadRunstate();
  const next = mutator(cur);
  writeFileSync(RUNSTATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}
