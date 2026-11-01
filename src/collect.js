/**
 * 夜班采集层：唯一有副作用的地方（读文件、跑 journalctl）。
 *
 * 命令执行器与文件读取都是注入的，理由很实在：这些测试必须能在开发机上跑，
 * 而 journalctl 只在 Linux 上有、审计文件只在服务器上有。注入之后，
 * 「journalctl 挂了怎么办」「目录不存在怎么办」这类分支才测得出来 ——
 * 今天 /home/dshqq 没建就挂了一整天的转写，正是没人覆盖过这类分支。
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { localDateKey, localDayStartUtc } from './digest.js';

export const DEFAULT_AUDIT_DIR = '/opt/dsh-qq-agent/audit';
/** 契约里点了名的两个 unit：桥负责转写与投递，插件负责轮次与 proactive。 */
export const DEFAULT_UNITS = Object.freeze(['dsh-qq-bridge', 'dsh-qq-agent']);

const pad = (value) => String(value).padStart(2, '0');

/**
 * 默认执行器：`execFile` 而不是 `exec`，参数按数组传。
 * 这是 `--since` 那个坑的根因 —— 走 shell 拼字符串时，服务器上的引号会被吃掉，
 * 于是 `--since "2026-11-02"` 变成 `--since 2026-11-02`，journalctl 只把 `--since`
 * 当参数、把日期当成一个 unit 名，结果安静地返回空。数组传参从根上没有这个问题。
 */
export function defaultExec({ command, args }) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** 窗口跨了 UTC 月份就要读两个分片文件。 */
export function auditMonthKeys(startMs, endMs) {
  const keys = [];
  const cursor = new Date(startMs);
  let year = cursor.getUTCFullYear();
  let month = cursor.getUTCMonth();
  for (;;) {
    if (Date.UTC(year, month, 1) >= endMs) break;
    keys.push(`${year}-${pad(month + 1)}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return keys;
}

/**
 * 采集一天的原始素材。永不抛：所有失败都进 `problems` 并打日志。
 *
 * @param options.date - 服务器本地日期 YYYY-MM-DD。
 * @param options.days - 回溯天数（7 = 周度）。
 * @param options.auditDir - 审计分片目录。
 * @param options.units - journalctl 的 -u 列表。
 * @param options.exec - 命令执行器 `({command, args}) => {code, stdout, stderr}`。
 * @param options.readFileImpl - 文件读取器，注入以便测试。
 * @param options.log - `(level, message)`。
 * @returns `{ auditLines, logLines, problems, files, commands, since }`
 */
export async function collect({
  date,
  days = 1,
  auditDir = DEFAULT_AUDIT_DIR,
  utcOffsetMinutes = 480,
  units = DEFAULT_UNITS,
  journalLimit = 5000,
  journalBinary = 'journalctl',
  exec = defaultExec,
  readFileImpl = readFile,
  log = () => {},
} = {}) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError(`date 必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
  }
  const windowEndMs = localDayStartUtc(date, utcOffsetMinutes) + 86_400_000;
  const windowStartMs = localDayStartUtc(date, utcOffsetMinutes) - (days - 1) * 86_400_000;
  // journalctl 的 --since 只要日期；用窗口起点那天的本地日期，周度自动就是 7 天前。
  const since = localDateKey(windowStartMs, utcOffsetMinutes);

  const problems = [];
  const files = [];
  const auditLines = [];

  for (const monthKey of auditMonthKeys(windowStartMs, windowEndMs)) {
    const path = join(auditDir, `audit-${monthKey}.jsonl`);
    let content;
    try {
      content = await readFileImpl(path, 'utf8');
    } catch (error) {
      const code = error?.code ?? '';
      // 目录不存在与「这个月还没写过」都只是少素材，不是故障；但要有人看得见。
      const kind = code === 'ENOENT' ? 'missing-audit' : 'unreadable-audit';
      const message = `${path} 读不到（${code === '' ? error?.message ?? String(error) : code}）`;
      problems.push({ kind, path, message });
      log(kind === 'missing-audit' ? 'warn' : 'error', `审计分片缺失：${message}`);
      files.push({ path, ok: false, lines: 0, error: code === '' ? String(error?.message ?? error) : code });
      continue;
    }
    const lines = String(content)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim() !== '');
    auditLines.push(...lines);
    files.push({ path, ok: true, lines: lines.length });
    log('info', `审计分片 ${path} 读到 ${lines.length} 行`);
  }

  const logLines = [];
  const commands = [];
  for (const unit of units) {
    const args = ['--no-pager', '-o', 'short-iso', '-u', unit, `--since=${since}`, '-n', String(journalLimit)];
    commands.push({ command: journalBinary, args });
    let result;
    try {
      result = await exec({ command: journalBinary, args });
    } catch (error) {
      const message = `${journalBinary} -u ${unit} 执行失败：${error?.message ?? String(error)}`;
      problems.push({ kind: 'journal-exec-failed', path: '', message });
      log('error', message);
      continue;
    }
    const stdout = String(result?.stdout ?? '');
    const stderr = String(result?.stderr ?? '').trim();
    if (result?.code !== 0) {
      // 非 0 不代表没内容（journalctl 在部分容器里会警告）；有 stdout 就照样用。
      const message = `${journalBinary} -u ${unit} 退出码 ${result?.code}${stderr === '' ? '' : `：${stderr.slice(0, 200)}`}`;
      problems.push({ kind: 'journal-nonzero', path: '', message });
      log('warn', message);
    }
    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) logLines.push({ unit, line });
    log('info', `${unit} 日志读到 ${lines.length} 行（--since=${since}）`);
  }

  return { date, days, since, auditLines, logLines, problems, files, commands };
}
