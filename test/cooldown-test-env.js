// 测试环境：把 runstate/session 落盘指到临时目录，避免读写真实运行状态。
// 必须在 import 任何 src 模块【之前】import 本文件（ESM 按 import 顺序执行）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SHUO_DATA_DIR = mkdtempSync(join(tmpdir(), 'shuo-cooldown-'));