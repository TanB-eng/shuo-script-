// 配置模块。敏感项（凭据、运行状态）一律从本地文件读取，不入库。
// 协议地址、消息类型、频率限制来自协议分析，不在此手工猜测。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
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
  // 递增冷却：每次"复活点被打断没回满"又下线的逃生，冷却在基础上 +30s，
  // 直到封顶 offlineCooldownCapSec（用户设置 5 分钟）。满血恢复后档位清零回到 90s。
  // 注意:逃生的冷却只在【主动逃生】时递增——自愈/手动等非作战下线保持基础 90s。
  offlineCooldownStepSec: 30,
  offlineCooldownCapSec: 300,
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
  // 触发距离(米)：未满血且【无人开火】时，有玩家进入此距离就径向远离。
  // 取 150m = 子弹射程 —— 打不到你的人不必躲。
  // 曾用 250m(想在对方进射程前就拉开)，但地图人多时 250m 内几乎恒有人，
  // 导致 bot 永远在移动、永远回不满血、永远不拾金(实测卡在 HP 65 三分钟)。
  evadeTriggerDistanceM: 150,
  // 解除距离(米)：威胁被拉开到此距离外就停下回血，不再白烧体力。
  // 必须大于触发距离，形成滞回，避免在边界反复抖动(跑一步就停、停一下又跑)。
  // 200m = 射程 150m + 50m 缓冲，既能脱离又不必长途奔袭。
  evadeSafeDistanceM: 200,
  // 规避时判定"撞墙卡住"的位移阈值与时间窗：
  // 若持续朝一个方向跑却几乎没位移(如顶到地图边界)，说明跑不动了，直接下线。
  // 注意：被威胁贴脸挡住/夹击时位移也会很小，所以窗口放宽到 8s、阈值降到 10m，
  // 避免在规避刚起步(方向还没跑开)时就误判撞墙、错误下线。
  evadeStuckWindowMs: 8000,
  evadeStuckMinMoveM: 10,
  // 卡住后的"绕行"持续时间(毫秒)：期间给移动方向叠加垂直偏移，绕开挡路的障碍/边界。
  // 旧实现只翻转 _strafeDir，但拾金路径 moveToCoin 不用该变量，等于毫无作用
  // （实测：D=168m 十几分钟不变，卡住告警反复打印却一直没动）。
  stuckDetourMs: 2500,
  aggroMinGold: 3,
  // 主动攻击圈半径(厘米) = 子弹射程 150m（官方教程：「红色虚线圆圈是 150m 攻击范围」）。
  // 用户要求：攻击范围就等于能射击的范围。攻击圈与射程重合后，
  // "出圈开始追击计时"与"出射程"合一，状态机更简单。
  aggroRadiusCm: 15000,
  // 实际开火的最大距离(厘米)：比攻击圈留 5m 缓冲。
  // 150m 边缘的目标稍一移动就出射程，子弹白飞还白烧体力（每发 0.3~0.5 点）。
  fireMaxRangeCm: 14500,
  // 逼近距离(厘米)：远于此值时改为"斜向逼近"缩短距离以提高命中率；
  // 近于此值就用"脉冲横移"专心走位输出。
  fireOptimalRangeCm: 12000,
  // 主动攻击连发节流由 shoot 自带 100ms 控制（≈服务器上限 10发/秒），不再额外冷却。
  // 保留此配置仅为兼容历史 config.json，不再参与锁定目标的攻击路径。
  aggroCooldownMs: 800,
  // 追击超时（毫秒）：目标离开【攻击圈 aggroRadiusCm】后开始计时，
  // 90 秒内没击杀就放弃他，等血满再继续拾金。
  // 他若重新回到攻击圈内，计时清零并继续攻击（不设放弃冷却）。
  aggroChaseTimeoutMs: 90000,
  // 主动开战的 1h 体力保护线(毫值)：低于此值不再主动锁定【新】目标（反击自保不受限）。
  //
  // 实测(2026-08-09)：186 点就被门槛锁死，导致 55 金币的 Rauze 在 150m 内也不主动打，
  // 只能被动挨打。原值 300 点是"移动 3000m 的余量"，但对一直跑的拾金 bot 太苛刻、
  // 几乎常态触达，把主动攻击静默饿死。真正不能打的只有"体力见底连移动都不行"。
  // 降到 80 点：既能保机动，又把门槛压到只有"接近物理极限"才拦，高价值目标照常打。
  aggroStaminaReserveMillis: 80 * 1000,

  // ---- 5s 体力窗口：战斗节奏的真正约束（官方规则推导） ----
  // 容量 10 点，回复 2 点/秒；移动 10m/s 耗 1 点/秒；开火 0.3~0.5 点/发。
  // => 持续移动只剩 1 点/秒给射击(2发/秒)；改成"脉冲走位"仅耗 0.4 点/秒，
  //    可留 1.6 点/秒给射击(3~5发/秒)，既不站桩又能保住输出。
  // 开火体力地板(毫值，1 点 = 1000)：5s 窗口低于此值立即停火，把体力全留给移动。
  // 体力耗尽 = 无法攻击也无法移动 = 逃不掉 = 死 = 掉光金币，必须无条件防住。
  // 实测(2026-08-09)：3000(3点) 导致边走位边打几步就"停火保移动"，攻速断断续续。
  // 降到 2000(2点)：5s 窗回复 2 点/秒，剩 2 点仍可支撑约 1 秒射击，攻速更连贯；
  // 且 2 点=可移动 2 秒，足够在下一次体力耗尽前完成移动。保守保留 2 点底线。
  fireStaminaFloorMilli: 2000,
  // 单发开火消耗(毫值)。教程写 0.5 点、体力说明图写 0.3 点，取保守值 500，
  // 由内置实测日志校准后再调。
  fireCostMilli: 500,
  // 脉冲走位节奏(毫秒)：跑 runMs 停 pauseMs。占空比 0.4 => 移动只耗 0.4 点/秒。
  strafePulseRunMs: 400,
  strafePulsePauseMs: 600,
  // 无效交火判定(毫秒)：持续开火这么久而目标 HP 一点没掉，判定无效
  // （无敌 INV / 全部打空 / 目标有误），脱离并短期拉黑，避免白烧体力。
  ineffectiveFireMs: 6000,
  // 无效交火后拉黑时长(毫秒)
  ineffectiveBlacklistMs: 30000,
  // 高金币掉落等待超时（毫秒）：判定击杀后，这段时间内掉落点附近仍没出现金币就放弃。
  // 取 10s：掉落会在下一个 1s snapshot 出现，10s 足够；同时把"误判击杀"的代价压到最小。
  richDropPendingTimeoutMs: 10000,

  // ---- 弹道提前量（打脚本专用）----
  // 子弹速度(cm/s)。null = 尚未实测，用下方估算值兜底（提前量立刻生效），实测到后自动覆盖。
  // 实测(2026-08-09)：真实射速被 5s 体力掐得稀疏，实测样本永远凑不齐，提前量一直没生效，
  // 导致全程"打当前位置"、打不中快速移动的对手。给一个中高速估算值先顶上。
  // 单位换算：100000 cm/s = 1000 m/s；游戏地图 10000m、玩家 10m/s，子弹取 200~500m/s 区间
  // 先给 300m/s(=30000cm/s) 作为初值，实测日志出现后会覆盖它。
  bulletSpeedCmS: 30000,
  // 提前量的最大容许开火距离(厘米)。提前量可能把瞄准点推到目标当前位置之后，
  // 若推出有效射程(fireMaxRangeCm)就不开火，避免白烧体力。
  leadMaxRangeCm: 15500,
  // 子弹速度实测采样的上限/下限(厘米/秒)，超范围样本丢弃(误匹配/量程异常)。
  bulletSpeedSampleMinCmS: 10000,   // 100 m/s
  bulletSpeedSampleMaxCmS: 100000,  // 1000 m/s

  // ---- 落地重定位（复活点被蹲的根治）----
  // 复活点位置固定且被蹲时，原地等待/再传送只会反复送死。落地后先向远离
  // "上次威胁方向"走一段(走路 500m≈50 点体力，远便宜过传送 1500 点)，再恢复常规行事。
  // relocateDistM 是目标距离，走到 relocateArriveM 内就算"已完成脱离"。
  relocateDistM: 800,
  relocateArriveM: 120,

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
// DATA_DIR 指向 session/runstate 的落盘目录。默认 .data；
// 测试进程可用环境变量 SHUO_DATA_DIR 指到临时目录，避免读写真实运行状态（绝对路径优先）。
const dataDirOverride = process.env.SHUO_DATA_DIR || CONFIG.dataDir || '.data';
const DATA_DIR = isAbsolute(dataDirOverride) ? dataDirOverride : join(ROOT, dataDirOverride);
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
