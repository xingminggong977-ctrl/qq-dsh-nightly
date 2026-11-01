#!/usr/bin/env node
/**
 * 03:00 的挖矿入口：采集 → 生成 digest 与 stats → 写文件。
 * 零 token：这里一次模型都不调，全是 grep 与计数。
 *
 * 所有路径都能用参数覆盖，默认值就是契约里写的线上路径，所以 dry-run
 * 与线上跑的是同一条代码路径，区别只在 --out-dir 指向哪。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join } from 'node:path';

import { collect, DEFAULT_AUDIT_DIR } from '../src/collect.js';
import { buildDigest, DIGEST_DEFAULTS, formatStats } from '../src/digest.js';

const DEFAULT_OUT_DIR = '/var/lib/dsh-qq-agent/nightly';
const DEFAULT_MEMORY_FILE = '/opt/dsh-qq-agent/persona/MEMORY.md';
const DEFAULT_MEMORY_LIMIT = 60;

const pad = (value) => String(value).padStart(2, '0');

/** 服务器本地「今天」。UTC 日期会差 8 小时，凌晨跑会写到前一天去。 */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function log(level, message) {
  // systemd 用 StandardOutput=append: 收走；带时间戳才好和 journal 对上。
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

const USAGE = `用法: node bin/nightly-digest.mjs [选项]

  --date=YYYY-MM-DD         要生成哪天的素材（默认服务器本地今天）
  --out-dir=PATH            输出目录（默认 ${DEFAULT_OUT_DIR}）
  --audit-dir=PATH          审计分片目录（默认 ${DEFAULT_AUDIT_DIR}）
  --memory-file=PATH        MEMORY.md 路径（默认 ${DEFAULT_MEMORY_FILE}）
  --memory-limit=N          MEMORY.md 行数上限（默认 ${DEFAULT_MEMORY_LIMIT}）
  --days=N                  回溯天数（默认 1；--weekly 时为 7）
  --max-lines=N             digest 行数上限（默认 ${DIGEST_DEFAULTS.maxLines}；--weekly 时为 400）
  --utc-offset-minutes=N    服务器本地时区偏移（默认 ${DIGEST_DEFAULTS.utcOffsetMinutes}，即 UTC+08:00）
  --weekly                  周度档：回溯 7 天、上限 400 行（文件名自动带 -weekly 后缀）
  --suffix=TEXT             文件名后缀（默认空；--weekly 时为 -weekly）
  --dry-run                 只打到 stdout，不写文件
  --help                    显示这段说明
`;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--weekly') {
      out.weekly = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`看不懂的参数：${arg}`);
    const eq = arg.indexOf('=');
    if (eq < 0) throw new Error(`参数要写成 --name=value：${arg}`);
    const name = arg.slice(2, eq).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    out[name] = arg.slice(eq + 1);
  }
  return out;
}

function readIntOption(raw, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw))) throw new Error(`--${name} 必须是整数，收到 ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`--${name} 必须在 ${min}..${max} 之间，收到 ${value}`);
  return value;
}

async function readMemory(path, limit) {
  try {
    const content = await readFileAsync(path, 'utf8');
    const trimmed = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const lines = trimmed === '' ? 0 : trimmed.split('\n').length;
    return { path, lines, limit };
  } catch (error) {
    // MEMORY.md 还没建是正常状态（她还没写过任何记忆），不值得让整晚失败。
    const code = error?.code ?? '';
    log(code === 'ENOENT' ? 'warn' : 'error', `读不到 MEMORY.md（${path}）：${code === '' ? (error?.message ?? String(error)) : code}`);
    return null;
  }
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log('error', error.message);
    process.stdout.write(USAGE);
    return 2;
  }
  if (options.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const date = options.date ?? localToday();
    const weekly = options.weekly === true;
    const days = readIntOption(options.days, 'days', weekly ? 7 : 1, { min: 1, max: 90 });
    const maxLines = readIntOption(options.maxLines, 'max-lines', weekly ? 400 : DIGEST_DEFAULTS.maxLines, { min: 10, max: 5000 });
    const utcOffsetMinutes = readIntOption(options.utcOffsetMinutes, 'utc-offset-minutes', DIGEST_DEFAULTS.utcOffsetMinutes, {
      min: -720,
      max: 840,
    });
    const memoryLimit = readIntOption(options.memoryLimit, 'memory-limit', DEFAULT_MEMORY_LIMIT, { min: 1, max: 10_000 });
    const outDir = options.outDir ?? DEFAULT_OUT_DIR;
    const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR;

    const collected = await collect({ date, days, auditDir, utcOffsetMinutes, log });
    if (collected.problems.length > 0) log('warn', `采集阶段有 ${collected.problems.length} 个问题，素材可能不全`);
    for (const problem of collected.problems) log('warn', `问题 ${problem.kind}: ${problem.message}`);

    const memory = await readMemory(options.memoryFile ?? DEFAULT_MEMORY_FILE, memoryLimit);
    const { markdown, stats } = buildDigest({
      date,
      auditLines: collected.auditLines,
      journal: collected.logLines,
      days,
      maxLines,
      utcOffsetMinutes,
      memory,
    });

    if (options.dryRun === true) {
      process.stdout.write(markdown);
      process.stdout.write(`\n----- stats -----\n${formatStats(stats)}`);
      log('info', `dry-run：未写文件（digest ${stats.renderedLines} 行）`);
      return 0;
    }

    mkdirSync(outDir, { recursive: true });
    // 周度与日度同在 03:00 触发，若都写 digest-<date>.md 就会互相覆盖，
    // 而 03:10 的复盘只读日度那份 —— 所以周度自己带后缀，两份都留得住。
    const suffix = options.suffix ?? (weekly ? '-weekly' : '');
    const digestPath = join(outDir, `digest-${date}${suffix}.md`);
    const statsPath = join(outDir, `stats-${date}${suffix}.md`);
    writeFileSync(digestPath, markdown, 'utf8');
    writeFileSync(statsPath, formatStats(stats), 'utf8');
    log(
      'info',
      `写好 ${digestPath}（${stats.renderedLines}/${maxLines} 行，裁剪 ${stats.trimmedLines} 行）与 ${statsPath}`,
    );
    return 0;
  } catch (error) {
    // 站在 crontab/timer 的角度，一屏堆栈不如一行原因。
    log('error', `生成失败：${error?.message ?? String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
