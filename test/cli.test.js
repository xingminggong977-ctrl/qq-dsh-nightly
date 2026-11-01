import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 这两个 CLI 是真会被 systemd 拉起来的入口，所以这里直接跑子进程而不是 import。
 * 不跑真 journalctl：Windows 上没有，正好顺带验证「命令不在也不崩」。
 */

const NIGHTLY = fileURLToPath(new URL('..', import.meta.url));
const BIN_DIGEST = join(NIGHTLY, 'bin', 'nightly-digest.mjs');
const BIN_REPORT = join(NIGHTLY, 'bin', 'morning-report.mjs');
const FIXTURES = join(NIGHTLY, 'test', 'fixtures');
const DATE = '2026-05-14';

const run = (script, args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { encoding: 'utf8', cwd: NIGHTLY }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('nightly-digest --dry-run：用夹具造出 digest，journalctl 不在也不崩', async () => {
  const { code, stdout } = await run(BIN_DIGEST, [
    `--date=${DATE}`,
    `--audit-dir=${FIXTURES}`,
    `--memory-file=${join(FIXTURES, '没有这个文件.md')}`,
    '--dry-run',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /# 夜班素材 2026-05-14/);
  assert.match(stdout, /## 概览/);
  assert.match(stdout, /private_reply 20/);
  assert.match(stdout, /- 664671782 连问 3 次/);
  // MEMORY.md 不存在只该是一条 warn，不该让整晚失败。
  assert.match(stdout, /读不到 MEMORY\.md/);
});

test('nightly-digest --weekly：回溯 7 天且上限 400 行', async () => {
  const { code, stdout } = await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, '--weekly', '--dry-run']);
  assert.equal(code, 0);
  assert.match(stdout, /共 7 天/);
  assert.match(stdout, /\/ 上限 400/);
});

test('nightly-digest 写文件：落到 --out-dir 下，文件名用本地日期', async (t) => {
  const outDir = tempDir(t);
  const { code, stdout } = await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`]);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`digest-${DATE}\\.md`));
  const digest = readFileSync(join(outDir, `digest-${DATE}.md`), 'utf8');
  const stats = readFileSync(join(outDir, `stats-${DATE}.md`), 'utf8');
  assert.match(digest, /# 夜班素材 2026-05-14/);
  assert.match(stats, /# 夜班计数 2026-05-14/);
});

test('nightly-digest 参数写错：退出码 2 并打用法，不抛栈', async () => {
  const { code, stdout, stderr } = await run(BIN_DIGEST, ['--乱写']);
  assert.equal(code, 2);
  assert.match(stdout, /用法/);
  assert.equal(stderr.trim(), '');
});

test('nightly-digest --weekly 写文件：带 -weekly 后缀，不覆盖日度那份', async (t) => {
  const outDir = tempDir(t);
  const { code } = await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`, '--weekly']);
  assert.equal(code, 0);
  assert.ok(existsSync(join(outDir, `digest-${DATE}-weekly.md`)));
  assert.ok(existsSync(join(outDir, `stats-${DATE}-weekly.md`)));
  assert.equal(existsSync(join(outDir, `digest-${DATE}.md`)), false);
});

test('morning-report --dry-run：拼出的私聊 ≤600 字', async (t) => {
  const outDir = tempDir(t);
  const generated = await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`]);
  assert.equal(generated.code, 0);

  const { code, stdout } = await run(BIN_REPORT, [`--date=${DATE}`, `--out-dir=${outDir}`, '--dry-run']);
  assert.equal(code, 0);
  const message = stdout.split('\n').find((line) => line.startsWith(`【夜班 ${DATE}】`));
  assert.ok(message !== undefined, '没找到私聊正文');
  const text = stdout.slice(stdout.indexOf(`【夜班 ${DATE}】`)).trimEnd();
  assert.ok([...text].length <= 600, `实际 ${[...text].length} 字`);
});

test('morning-report 缺 digest：退出码 1，一行原因，不吐堆栈', async (t) => {
  const outDir = tempDir(t);
  const { code, stdout, stderr } = await run(BIN_REPORT, [`--date=${DATE}`, `--out-dir=${outDir}`, '--dry-run']);
  assert.equal(code, 1);
  assert.match(stdout, /读不到 digest/);
  assert.doesNotMatch(stdout, /\n\s+at\s/);
  assert.equal(stderr.trim(), '');
});

test('morning-report 没给收件人和 token：不发，退出码 2', async (t) => {
  const outDir = tempDir(t);
  await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`]);
  const { code, stdout } = await run(BIN_REPORT, [`--date=${DATE}`, `--out-dir=${outDir}`]);
  assert.equal(code, 2);
  assert.match(stdout, /没有收件人/);
});

test('morning-report 桥接不可达：退出码 1，不崩', async (t) => {
  const outDir = tempDir(t);
  await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`]);

  const env = {
    ...process.env,
    NODE_TOKEN: 'token-abc',
    OWNER_QQ: '10001',
    BRIDGE_URL: 'http://127.0.0.1:9',
  };
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(process.execPath, [BIN_REPORT, `--date=${DATE}`, `--out-dir=${outDir}`], { encoding: 'utf8', cwd: NIGHTLY, env }, (error, out, err) => {
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code: exitCode, stdout: out, stderr: err });
    });
  });
  assert.equal(code, 1);
  assert.match(stdout, /晨报未发出/);
  assert.doesNotMatch(stdout, /\n\s+at\s/);
  assert.equal(stderr.trim(), '');
});

test('提案目录不存在不该让晨报失败', async (t) => {
  const outDir = tempDir(t);
  await run(BIN_DIGEST, [`--date=${DATE}`, `--audit-dir=${FIXTURES}`, `--out-dir=${outDir}`]);
  const proposalsDir = join(tempDir(t), 'proposals');
  const { code, stdout } = await run(BIN_REPORT, [
    `--date=${DATE}`,
    `--out-dir=${outDir}`,
    `--proposals-dir=${proposalsDir}`,
    '--dry-run',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /提案目录读不到/);
  assert.match(stdout, /提案 0 条/);
});
