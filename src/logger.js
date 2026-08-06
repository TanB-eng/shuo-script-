// 极简日志模块。控制台输出状态/目标/战斗/逃生/重连日志。
// 敏感信息（token）在任何级别都不打印。

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, silent: 5 };

let level = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

export function setLogLevel(name) {
  const l = LEVELS[name];
  if (l !== undefined) level = l;
}

function ts() {
  return new Date().toISOString();
}

function emit(lvl, parts) {
  if (lvl < level) return;
  console.log(`${ts()} [${lvl === LEVELS.info ? 'info' : lvl === LEVELS.debug ? 'debug' : lvl === LEVELS.warn ? 'warn' : lvl === LEVELS.error ? 'error' : 'trace'}]`, ...parts);
}

export const log = {
  trace: (...a) => emit(LEVELS.trace, a),
  debug: (...a) => emit(LEVELS.debug, a),
  info: (...a) => emit(LEVELS.info, a),
  warn: (...a) => emit(LEVELS.warn, a),
  error: (...a) => emit(LEVELS.error, a),
};

// 脱敏调试：打印对象但绝不泄漏 token。
export function safe(obj, depth = 0) {
  if (depth > 2) return '[deep]';
  if (Array.isArray(obj)) return obj.slice(0, 5).map((o) => safe(o, depth + 1)).concat(obj.length > 5 ? [`…+${obj.length - 5}`] : []);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (/token|secret|session|auth/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = safe(obj[k], depth + 1);
      }
    }
    return out;
  }
  return obj;
}