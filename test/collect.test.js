import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditMonthKeys, collect, DEFAULT_UNITS } from '../src/collect.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DATE = '2026-05-14';
const journalText = readFileSync(join(FIXTURES, 'journal-sample.txt'), 'utf8');

/** 假的命令执行器：把 journalctl 换成一段固定 stdout，顺便记下每次调用。 */
function fakeExec({ stdout = journalText, code = 0, stderr = '', throws = null } = {}) {
  const calls = [];
  const exec = async ({ command, args }) => {
    calls.push({ command, args });
    if (throws !== null) throw throws;
    return { code, stdout, stderr };
  };
  return { exec, calls };
}

test('--since 用等号无空格形式，每个 unit 一条命令', async () => {
  const { exec, calls } = fakeExec();
  const result = await collect({ date: DATE, auditDir: FIXTURES, exec, readFileImpl: readFile });

  assert.equal(result.since, '2026-05-14');
  assert.equal(calls.length, DEFAULT_UNITS.length);
  for (const call of calls) {
    assert.equal(call.command, 'journalctl');
    // 服务器上引号会被吃掉，`--since 2026-05-14` 会让 journalctl 把它当 unit 名静默返回空。
    assert.ok(call.args.includes(`--since=${DATE}`), `缺少 --since=${DATE}`);
    assert.ok(!call.args.includes('--since'), '不允许出现裸 --since');
    assert.ok(!call.args.includes(`"${DATE}"`), '不允许带引号');
    assert.ok(call.args.includes('--no-pager'));
  }
  assert.deepEqual(calls.map((call) => call.args[call.args.indexOf('-u') + 1]), [...DEFAULT_UNITS]);
  assert.equal(result.logLines.length, 2 * journalText.trimEnd().split('\n').length);
  assert.equal(result.problems.length, 0);
});

test('周度：--since 落到 7 天前那一天，审计窗口同步变宽', async () => {
  const { exec } = fakeExec();
  const result = await collect({ date: DATE, days: 7, auditDir: FIXTURES, exec, readFileImpl: readFile });
  assert.equal(result.since, '2026-05-08');
  assert.ok(result.commands.every((command) => command.args.includes('--since=2026-05-08')));
});

test('审计目录不存在：记一条 missing-audit，不抛也不静默', async () => {
  const { exec } = fakeExec();
  const logs = [];
  const result = await collect({
    date: DATE,
    auditDir: join(FIXTURES, '这个目录不存在'),
    exec,
    readFileImpl: readFile,
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal(result.auditLines.length, 0);
  const missing = result.problems.filter((problem) => problem.kind === 'missing-audit');
  assert.equal(missing.length, 1);
  assert.equal(result.files[0].ok, false);
  assert.equal(result.files[0].error, 'ENOENT');
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('审计分片缺失')));
});

test('journalctl 退出码非 0 但有 stdout：照样用那些行，同时留一条警告', async () => {
  const { exec } = fakeExec({ code: 1, stderr: 'Failed to get journal' });
  const result = await collect({ date: DATE, auditDir: FIXTURES, exec, readFileImpl: readFile });
  assert.equal(result.problems.filter((problem) => problem.kind === 'journal-nonzero').length, DEFAULT_UNITS.length);
  assert.ok(result.logLines.length > 0);
  assert.match(result.problems[0].message, /退出码 1：Failed to get journal/);
});

test('命令执行器直接抛异常：记 journal-exec-failed，整轮不失败', async () => {
  const { exec } = fakeExec({ throws: new Error('spawn journalctl ENOENT') });
  const result = await collect({ date: DATE, auditDir: FIXTURES, exec, readFileImpl: readFile });
  assert.equal(result.problems.filter((problem) => problem.kind === 'journal-exec-failed').length, DEFAULT_UNITS.length);
  assert.equal(result.logLines.length, 0);
  // 审计那半仍然读到了 —— 一侧坏掉不该拖垮另一侧。
  assert.equal(result.auditLines.length, 30);
});

test('读文件失败（非 ENOENT）走 error 级，不吞', async () => {
  const result = await collect({
    date: DATE,
    auditDir: '/whatever',
    exec: fakeExec().exec,
    readFileImpl: async () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.equal(result.problems[0].kind, 'unreadable-audit');
});

test('auditMonthKeys：窗口跨 UTC 月要读两个分片', () => {
  assert.deepEqual(auditMonthKeys(Date.parse('2026-04-30T20:00:00Z'), Date.parse('2026-05-02T00:00:00Z')), [
    '2026-04',
    '2026-05',
  ]);
  assert.deepEqual(auditMonthKeys(Date.parse('2026-05-13T16:00:00Z'), Date.parse('2026-05-14T16:00:00Z')), ['2026-05']);
});

test('参数校验：date 不合法立刻抛', async () => {
  await assert.rejects(() => collect({ date: '14/05/2026' }), TypeError);
});
