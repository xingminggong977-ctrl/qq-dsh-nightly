#!/usr/bin/env node
/**
 * 08:30 的汇总：读昨晚的 digest + stats + 当天的提案目录，发一条 ≤600 字的私聊。
 *
 * 桥接挂了不许崩 —— 重启窗口里这条定时任务照样会跑。所以所有失败路径
 * 都是「一行日志 + 非 0 退出码」，绝不吐堆栈：堆栈进 /var/log 之后
 * 只能证明它崩了，证明不了为什么。
 */

import { readFile as readFileAsync, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildReportMessage, postPrivateText, REPORT_DEFAULTS } from '../src/report.js';

const DEFAULT_OUT_DIR = '/var/lib/dsh-qq-agent/nightly';
const DEFAULT_PROPOSALS_DIR = '/opt/dsh-qq-agent/proposals';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';

const pad = (value) => String(value).padStart(2, '0');

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function log(level, message) {
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

const USAGE = `用法: node bin/morning-report.mjs [选项]

  --date=YYYY-MM-DD         发哪天的汇总（默认服务器本地今天）
  --out-dir=PATH            digest/stats 所在目录（默认 ${DEFAULT_OUT_DIR}）
  --proposals-dir=PATH      提案根目录（默认 ${DEFAULT_PROPOSALS_DIR}，会读 <dir>/<date>/）
  --to=QQ号                 收件人（默认取 OWNER_QQ，其次 ALERT_QQ）
  --max-chars=N             字数上限（默认 ${REPORT_DEFAULTS.maxChars}）
  --dry-run                 只打到 stdout，不发
  --help                    显示这段说明

环境变量：NODE_TOKEN（必填）、BRIDGE_URL（默认 ${DEFAULT_BRIDGE_URL}）
`;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
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

/** OWNER_QQ 允许逗号/空格分隔的多个号，取第一个；其次退回 ALERT_QQ。 */
function resolveOwner(explicit, env) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  for (const key of ['OWNER_QQ', 'ALERT_QQ']) {
    const raw = String(env[key] ?? '').trim();
    if (raw === '') continue;
    const first = raw.split(/[,\s]+/).filter((part) => /^\d+$/.test(part))[0];
    if (first !== undefined) return first;
  }
  return '';
}

async function readTextOr(path) {
  try {
    return { ok: true, text: await readFileAsync(path, 'utf8') };
  } catch (error) {
    const code = error?.code ?? '';
    return { ok: false, code, error: code === '' ? String(error?.message ?? error) : code };
  }
}

async function listProposals(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = error?.code ?? '';
    // 没有提案目录是最常见的情况（她昨晚没想改代码），只提示，不失败。
    log('warn', `提案目录读不到（${dir}）：${code === '' ? (error?.message ?? String(error)) : code}`);
    return [];
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
    const outDir = options.outDir ?? DEFAULT_OUT_DIR;
    const proposalsRoot = options.proposalsDir ?? DEFAULT_PROPOSALS_DIR;
    const maxChars = options.maxChars === undefined ? REPORT_DEFAULTS.maxChars : Number(options.maxChars);
    if (!Number.isInteger(maxChars) || maxChars < 50) throw new Error(`--max-chars 必须是 ≥50 的整数，收到 ${JSON.stringify(options.maxChars)}`);

    const digestPath = join(outDir, `digest-${date}.md`);
    const statsPath = join(outDir, `stats-${date}.md`);

    const digest = await readTextOr(digestPath);
    if (!digest.ok) {
      log('error', `读不到 digest（${digestPath}）：${digest.error} —— 03:00 那次挖矿可能没跑`);
      return 1;
    }
    const stats = await readTextOr(statsPath);
    if (!stats.ok) log('warn', `读不到 stats（${statsPath}）：${stats.error}，汇总里会少一行`);

    const proposals = await listProposals(join(proposalsRoot, date));
    const { text, chars, truncated } = buildReportMessage({
      date,
      digest: digest.text,
      stats: stats.ok ? stats.text : '',
      proposals,
      digestPath,
      maxChars,
    });
    log('info', `汇总 ${chars} 字${truncated ? '（已按上限裁剪）' : ''}，提案 ${proposals.length} 条`);

    if (options.dryRun === true) {
      process.stdout.write(`${text}\n`);
      return 0;
    }

    const to = resolveOwner(options.to, process.env);
    if (to === '') {
      log('error', '没有收件人：给 --to，或设置 OWNER_QQ / ALERT_QQ');
      return 2;
    }
    const token = String(process.env.NODE_TOKEN ?? '').trim();
    if (token === '') {
      log('error', 'NODE_TOKEN 未设置：桥接的 /node/* 全部要鉴权，这条发不出去');
      return 2;
    }
    const url = String(process.env.BRIDGE_URL ?? '').trim() || DEFAULT_BRIDGE_URL;

    const result = await postPrivateText({ url, token, to, text, log });
    if (!result.ok) {
      // 不抛：桥接不在是环境问题，02:00 重启窗口里这条任务照跑。
      log('error', `晨报未发出（status=${result.status}）：${result.error}`);
      return 1;
    }
    return 0;
  } catch (error) {
    log('error', `晨报失败：${error?.message ?? String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
