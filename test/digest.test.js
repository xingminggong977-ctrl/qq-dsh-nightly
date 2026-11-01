import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDigest,
  DIGEST_DEFAULTS,
  formatOffset,
  formatStats,
  localDateKey,
  localDayStartUtc,
  parseAuditLine,
  parseJournalLine,
} from '../src/digest.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DATE = '2026-05-14';

/** 夹具按行读，空行滤掉 —— collect 也是这样切的，保持两边一致。 */
const readLines = (relativePath) =>
  readFileSync(join(FIXTURES, relativePath), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');

const auditLines = readLines('audit-2026-05.jsonl');
/** 真实 collect 会把 unit 一并带上来，这里照做，digest 里才数得清几个 unit。 */
const journal = readLines('journal-sample.txt').map((line) => ({ unit: 'dsh-qq-bridge', line }));

const digestOf = (overrides = {}) =>
  buildDigest({ date: DATE, auditLines, journal, memory: { path: '/x/MEMORY.md', lines: 39, limit: 60 }, ...overrides });

const markdownLines = (markdown) => markdown.replace(/\n+$/, '').split('\n');

test('空审计文件：只有标题与概览，不写没有内容的小节', () => {
  const { markdown, stats } = buildDigest({ date: DATE, auditLines: [], journal: [] });
  assert.equal(markdownLines(markdown)[0], `# 夜班素材 ${DATE}`);
  assert.match(markdown, /## 概览/);
  // 契约允许小节缺失：没有记忆数据时 node-plugin 不该看到这一节。
  assert.doesNotMatch(markdown, /## 记忆现状/);
  assert.equal(stats.audit.linesRead, 0);
  assert.equal(stats.audit.inWindow, 0);
  assert.equal(stats.audit.badLines, 0);
});

test('审计行损坏：半行 JSON 与非 JSON 都记成坏行，不静默丢', () => {
  const corrupt = readLines('audit-corrupt-2026-05.jsonl');
  const { stats } = buildDigest({ date: DATE, auditLines: corrupt });
  assert.equal(stats.audit.linesRead, 5);
  assert.equal(stats.audit.badLines, 2);
  assert.equal(stats.audit.inWindow, 3);
  // 坏行不参与统计，但必须有个数，否则「昨晚少了什么」无从查起。
  assert.equal(stats.audit.byKind.private_reply, 3);
});

test('跨 UTC/本地日期边界：00:30 本地算今天，23:30 本地算昨天', () => {
  const sameLocalDay = '{"at":"2026-05-13T16:30:00.000Z","kind":"private_reply","ok":true,"target":"1","chars":2,"text":"嗯。"}';
  const previousLocalDay = readLines('yesterday/audit-2026-05.jsonl');
  const { stats } = buildDigest({ date: DATE, auditLines: [sameLocalDay, ...previousLocalDay] });

  assert.equal(localDateKey(Date.parse('2026-05-13T16:30:00.000Z')), '2026-05-14');
  assert.equal(localDateKey(Date.parse('2026-05-13T15:30:00.000Z')), '2026-05-13');
  assert.equal(stats.audit.inWindow, 1);
  assert.equal(stats.audit.outsideWindow, 1);
});

test('周度窗口：days=7 把起点往前推 6 天，仍按本地零点算', () => {
  assert.equal(new Date(localDayStartUtc('2026-05-14')).toISOString(), '2026-05-13T16:00:00.000Z');
  const { stats } = buildDigest({ date: DATE, auditLines, journal, days: 7, maxLines: 400 });
  assert.equal(stats.windowStartIso, '2026-05-07T16:00:00.000Z');
  assert.equal(stats.windowEndIso, '2026-05-14T16:00:00.000Z');
  assert.equal(stats.weekly, true);
});

test('确定性：同一输入两次产出逐字节相同', () => {
  const first = digestOf();
  const second = digestOf();
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(first.stats, second.stats);
});

test('四类异常各被认出来：转写/投递/proactive 无话/空回复', () => {
  const { markdown, stats } = digestOf();
  assert.equal(stats.journal.asrFailures, 1);
  assert.equal(stats.journal.deliveryFailures, 2); // 桥的 delivered:false 与 NapCat 的 retcode 1200 各一条
  assert.equal(stats.journal.proactiveDeclines, 1);
  assert.equal(stats.journal.emptyReplies, 1);
  assert.equal(stats.journal.retries, 1);
  assert.equal(stats.journal.proactiveAsks, 1);

  assert.match(markdown, /- \[asr\] 转写失败 1 次/);
  assert.match(markdown, /PermissionError/);
  assert.match(markdown, /- \[delivery\] 投递失败 2 次/);
  assert.match(markdown, /- \[proactive\] proactive 无话可说 1 次/);
  assert.match(markdown, /- \[empty\]/);
  // 证据时间戳必须是 UTC 带 Z，本地时间会凭空差 8 小时。
  assert.match(markdown, /05-14 05:57:22Z/);
  // 投递失败的原因要落在紧随其后的那行上，不能只剩一个 `delivered:false` 的 JSON 尾巴。
  assert.match(markdown, /send_private_msg failed for 664671782/);
});

test('proactive 无话用「taskId 夹在中间」的真实写法才认得出', () => {
  const withTaskId = parseJournalLine('2026-05-14T06:03:00+00:00 node[901]: qq-node: proactive turn p-2210 declined');
  assert.equal(withTaskId.json, null);
  const { stats } = buildDigest({ date: DATE, auditLines: [], journal: ['qq-node: proactive turn p-2210 declined'] });
  assert.equal(stats.journal.proactiveDeclines, 1);
});

test('她的回避：按短语计数，只列 target 与时间，不编来信原文', () => {
  const { markdown, stats } = digestOf();
  assert.equal(stats.avoidance.hits, 6);
  assert.equal(stats.avoidance.rows, 5);
  assert.deepEqual(stats.avoidance.byPhrase, { 抱歉: 2, 不知道: 2, 不清楚: 1, 没听懂: 1 });
  assert.match(markdown, /- 「不知道」2 次：target 81234567 @ 05-13 17:02:11Z/);
  assert.match(markdown, /审计不含来信原文/);
});

test('重复问题：同 target 窗口内连问 3 次且回复都很短才算答偏', () => {
  const { markdown, stats } = digestOf();
  assert.equal(stats.repeatIssues.length, 1);
  assert.equal(stats.repeatIssues[0].target, '664671782');
  assert.equal(stats.repeatIssues[0].count, 3);
  assert.match(markdown, /- 664671782 连问 3 次/);

  // 阈值是参数不是常量：抬到 4 次就不该再报。
  const strict = buildDigest({ date: DATE, auditLines, repeat: { minAsks: 4 } });
  assert.equal(strict.stats.repeatIssues.length, 0);
  // 窗口收紧到 5 分钟，那三次连问就散了。
  const narrow = buildDigest({ date: DATE, auditLines, repeat: { windowMs: 5 * 60 * 1000 } });
  assert.equal(narrow.stats.repeatIssues.length, 0);
  // 回复长度上限放到底，长回复也算「小」时仍只报这一组。
  const loose = buildDigest({ date: DATE, auditLines, repeat: { maxChars: 100 } });
  assert.equal(loose.stats.repeatIssues.length, 1);
});

test('200 行上限：超了就按小节优先级裁剪，并在 stats 里写明裁掉多少', () => {
  const { markdown, stats } = digestOf({ maxLines: 20 });
  assert.ok(markdownLines(markdown).length <= 20, `实际 ${markdownLines(markdown).length} 行`);
  assert.ok(stats.trimmedLines > 0);
  assert.match(markdown, /已按 20 行上限裁剪 \d+ 行/);
  // 概览最后才砍：它是 08:30 那条私聊的唯一信息来源。
  assert.match(markdown, /## 概览/);
});

test('默认上限是 200 行且默认档不裁剪', () => {
  assert.equal(DIGEST_DEFAULTS.maxLines, 200);
  const { markdown, stats } = digestOf();
  assert.ok(markdownLines(markdown).length <= 200);
  assert.equal(stats.trimmedLines, 0);
  assert.equal(stats.maxLines, 200);
});

test('记忆现状：给了就显示行数，超限要写明', () => {
  const ok = digestOf({ memory: { path: '/x/MEMORY.md', lines: 39, limit: 60 } });
  assert.match(ok.markdown, /- MEMORY\.md 39 行 \/ 上限 60/);
  const over = digestOf({ memory: { path: '/x/MEMORY.md', lines: 63, limit: 60 } });
  assert.match(over.markdown, /- MEMORY\.md 63 行 \/ 上限 60（已超限 3 行）/);
});

test('参数非法要当场抛，不要产出半份素材', () => {
  assert.throws(() => buildDigest({ date: '2026/05/14' }), TypeError);
  assert.throws(() => buildDigest({ date: DATE, days: 0 }), TypeError);
});

test('stats 可读渲染：窗口、计数、阈值都在里面', () => {
  const { stats } = digestOf();
  const rendered = formatStats(stats);
  assert.match(rendered, new RegExp(`^# 夜班计数 ${DATE}`));
  assert.match(rendered, /- 日期 2026-05-14（服务器本地 UTC\+08:00），共 1 天/);
  assert.match(rendered, /- 重复问题阈值：同 target 3 次 \/ 30 分钟内 \/ 回复 ≤20 字/);
  assert.match(rendered, /- digest 行数 \d+ \/ 上限 200（裁剪 0 行）/);
  assert.equal(formatOffset(480), 'UTC+08:00');
  assert.equal(formatOffset(-300), 'UTC-05:00');
});

test('parseAuditLine：缺字段与非法时间都算坏行', () => {
  assert.equal(parseAuditLine('{"kind":"private_reply"}').ok, false);
  assert.equal(parseAuditLine('{"at":"不是时间","kind":"private_reply"}').ok, false);
  assert.equal(parseAuditLine('').empty, true);
  const good = parseAuditLine('{"at":"2026-05-14T00:00:00Z","kind":"private_reply","text":"嗯。"}');
  assert.equal(good.ok, true);
  assert.equal(good.row.chars, 2); // chars 缺失时退回 text.length
});

test('工具标记：剥离记一次，审计里还有漏出的就单独骂一句', () => {
  const stripped = digestOf({
    journal: [{ unit: 'dsh-qq-agent', line: 'qq-node: stripped tool markup from a reply (345 → 0 chars)' }],
  });
  assert.equal(stripped.stats.journal.toolMarkupStrips, 1);
  assert.equal(stripped.stats.journal.toolMarkupLeaks, 0);
  assert.match(stripped.markdown, /- \[markup\] 工具标记被剥离 1 次/);
  assert.match(stripped.markdown, /工具标记：剥离 1 次，审计里仍漏出 0 条/);

  // 没有剥离日志、但审计文本里还带着标记 —— 说明闸没拦住，这一条必须自己冒出来。
  const leaked = buildDigest({
    date: DATE,
    auditLines: ['{"at":"2026-05-14T07:08:17Z","kind":"private_reply","ok":true,"target":"2123748045","chars":345,"text":"<｜｜DSML｜｜ calls>\\n<｜｜DSML｜｜ invoke name=\\"bash\\">"}'],
    journal: [],
  });
  assert.equal(leaked.stats.journal.toolMarkupLeaks, 1);
  assert.match(leaked.markdown, /- \[markup\] 工具标记漏进回复 1 条/);
});

test('工具标记：干净的回复不会被误计', () => {
  const clean = digestOf();
  assert.equal(clean.stats.journal.toolMarkupLeaks, 0);
  assert.doesNotMatch(clean.markdown, /\[markup\]/);
});
