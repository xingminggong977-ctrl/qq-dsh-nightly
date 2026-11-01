import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDigest, formatStats } from '../src/digest.js';
import { buildReportMessage, extractBullets, postPrivateText, REPORT_DEFAULTS, SEND_BODY_KEYS } from '../src/report.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DATE = '2026-05-14';

const readLines = (relativePath) =>
  readFileSync(join(FIXTURES, relativePath), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');

const { markdown: digest, stats } = buildDigest({
  date: DATE,
  auditLines: readLines('audit-2026-05.jsonl'),
  journal: readLines('journal-sample.txt'),
  memory: { path: '/x/MEMORY.md', lines: 39, limit: 60 },
});
const statsMarkdown = formatStats(stats);

test('晨报拼装：头部带日期，从概览与异常取要点，整体 ≤600 字', () => {
  const { text, chars, truncated } = buildReportMessage({
    date: DATE,
    digest,
    stats: statsMarkdown,
    proposals: [],
    digestPath: `/var/lib/dsh-qq-agent/nightly/digest-${DATE}.md`,
  });
  assert.ok(text.startsWith(`【夜班 ${DATE}】`));
  assert.equal([...text].length, chars);
  assert.ok(chars <= REPORT_DEFAULTS.maxChars, `实际 ${chars} 字`);
  assert.doesNotMatch(text, /\n\n/); // 一行一条，QQ 里才好读
  assert.match(text, /提案 0 条/);
  assert.match(text, /完整清单：\/var\/lib\/dsh-qq-agent\/nightly\/digest-2026-05-14\.md/);

  // 素材本来就短的时候不该裁：两三条要点原样带出去。
  const short = buildReportMessage({ date: DATE, digest: '## 概览\n- private_reply 3\n- 转写失败 0' });
  assert.equal(short.truncated, false);
  assert.match(short.text, /- private_reply 3/);
});

test('晨报长度上限：素材超长时逐条丢要点，绝不发出超长消息', () => {
  const fat = [
    '## 概览',
    ...Array.from(
      { length: 40 },
      (_, index) =>
        `- 第 ${index} 条：这是一条很长很长很长的观测记录，用来把字数顶上去并验证裁剪顺序，还要再补一点细节让它稳定超过六百字的上限值，这样断言才有意义`,
    ),
    '## 异常',
    '- [asr] 转写失败 3 次',
  ].join('\n');
  const { text, chars, truncated } = buildReportMessage({ date: DATE, digest: fat, proposals: ['01-a.patch'] });
  assert.ok(chars <= REPORT_DEFAULTS.maxChars, `实际 ${chars} 字`);
  assert.equal(truncated, true);
  // 超长时保留头部与尾部（提案、路径），丢中间要点。
  assert.ok(text.startsWith(`【夜班 ${DATE}】`));
  assert.match(text, /提案 1 条：01-a\.patch/);
});

test('晨报只从概览与异常两节取要点', () => {
  const bullets = extractBullets(digest);
  assert.ok(bullets.length > 0);
  assert.ok(bullets.every((line) => line.startsWith('- ')));
  // 「她的回避」那节不该被塞进 600 字里 —— 它太长，且不是早上要看的东西。
  assert.ok(!bullets.some((line) => line.includes('审计不含来信原文')));
});

test('提案超过 3 条时用省略号收尾', () => {
  const { text } = buildReportMessage({ date: DATE, digest, proposals: ['01-a.patch', '02-b.patch', '03-c.patch', '04-d.patch'] });
  assert.match(text, /提案 4 条：01-a\.patch、02-b\.patch、03-c\.patch…/);
});

test('请求体字段就是 SEND_BODY_KEYS：kind / to / text', async () => {
  const seen = [];
  const result = await postPrivateText({
    url: 'http://127.0.0.1:8787',
    token: 'token-abc',
    to: '10001',
    text: '你好',
    fetchImpl: async (target, options) => {
      seen.push({ target, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, 'http://127.0.0.1:8787/node/send');
  assert.equal(seen[0].options.method, 'POST');
  assert.equal(seen[0].options.headers.authorization, 'Bearer token-abc');
  const body = JSON.parse(seen[0].options.body);
  assert.deepEqual(Object.keys(body), [...SEND_BODY_KEYS]);
  assert.deepEqual(body, { kind: 'private', to: '10001', text: '你好' });
});

test('桥接不可达：一行日志 + ok:false，不抛栈', async () => {
  const logs = [];
  const result = await postPrivateText({
    url: 'http://127.0.0.1:8787',
    token: 'token-abc',
    to: '10001',
    text: '你好',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'fetch failed');
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('桥接不可达')));
});

test('桥接返回 404（/node/send 还不存在）：明确报缺口，不假装成功', async () => {
  const logs = [];
  const result = await postPrivateText({
    url: 'http://127.0.0.1:8787',
    token: 'token-abc',
    to: '10001',
    text: '你好',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 }),
    log: (level, message) => logs.push({ level, message }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.ok(logs.some((entry) => entry.message.includes('需要桥接补上 /node/send')));
});

test('桥接回 200 但 ok:false：也算失败', async () => {
  const result = await postPrivateText({
    url: 'http://127.0.0.1:8787',
    token: 'token-abc',
    to: '10001',
    text: '你好',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'napcat offline' }), { status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bridge rejected');
});

test('缺 token / 收件号非法：不碰网络，直接 ok:false', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return new Response('{}', { status: 200 });
  };
  const noToken = await postPrivateText({ url: 'http://127.0.0.1:8787', token: '', to: '10001', text: 'x', fetchImpl });
  const badTo = await postPrivateText({ url: 'http://127.0.0.1:8787', token: 't', to: 'abc', text: 'x', fetchImpl });
  assert.equal(noToken.ok, false);
  assert.equal(badTo.ok, false);
  assert.equal(called, 0);
});
