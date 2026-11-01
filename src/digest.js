/**
 * 夜班素材（digest + stats）：纯函数层。
 *
 * 这里不读时钟、不读文件、不打日志 —— 同一份输入必须产出逐字节相同的输出。
 * 理由：夜里 03:00 跑完、早上发现要 `--date=昨天` 重跑时，结果必须对得上，
 * 否则「昨晚到底写了什么」永远查不清；顺带让所有日期边界都能被单测钉死。
 *
 * 时间一律由参数传入：`date` 是服务器本地日期，`utcOffsetMinutes` 是本地时区偏移。
 * 用固定偏移而不是 Intl 时区名，是因为服务器在 Asia/Shanghai（无夏令时），
 * 固定 +480 就够，而且跨机器、跨 ICU 版本都稳定；Intl 在精简容器的 Node 里还可能缺数据。
 */

/**
 * 四类已知失败在日志里的签名。全部对着仓库里的真实写法取的，不是凭空猜的：
 * - 转写失败：bridge/src/asr.js:60 `log?.warn?.('voice transcription failed', {...})`
 * - 投递失败：bridge/src/dispatch.js `log.warn('task finished', { delivered: false })`，
 *   以及 NapCat 拒绝时的 retcode 1200；deploy/diag-cost.sh:20 也用了同一条正则。
 * - proactive 无话：node-plugin/lib/runner.js:255，正文形如
 *   `qq-node: proactive turn <taskId> declined` —— taskId 夹在中间，
 *   所以不能用字面量 "proactive turn declined" 去 grep，那样线上永远匹配 0 行。
 * - 空回复：bridge/src/http.js:183 / dispatch.js:484 打印的 `textChars`。
 */
const ASR_PATTERN = /voice transcription failed|transcription failed/i;
const DELIVERY_PATTERN = /delivered\s*"?\s*[:=]\s*false|retcode\s*"?\s*[:=]?\s*1200/i;
const PROACTIVE_DECLINE_PATTERN = /proactive turn\b.*\bdeclined/i;
const EMPTY_REPLY_PATTERN = /textChars\s*"?\s*[:=]\s*0\b/;
/** dispatch.js 单条 `qq reply failed after retries`；有的版本逐次打 retrying。 */
const RETRY_PATTERN = /\bretr(?:ying|ied)\b|after retries|\battempt\s+[2-9]\b/i;
/** bridge/src/proactive.js:70 `log.info('proactive ask queued', ...)`。 */
const PROACTIVE_ASK_PATTERN = /proactive ask queued/i;
/**
 * 工具调用的文本协议漏进聊天（2026-10-28：对外会话没有工具，`<||DSML|| calls>`
 * 被当成正文发给了陌生人）。修好之后出闸会剥掉并打 `stripped tool markup`，
 * 所以两头都数：日志抓"剥了几次"，审计抓"还有没有真漏出去的"。
 */
const TOOL_MARKUP_PATTERN = /stripped tool markup/i;
export const TOOL_MARKUP_TEXT = /<[|｜]{2}\s*DSML/i;

const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const CLASSIC_STAMP = /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 小节标题固定，node-plugin 侧按这个认；契约里写了「小节缺失是允许的」。 */
export const SECTION_TITLES = Object.freeze({
  overview: '## 概览',
  anomalies: '## 异常',
  repeats: '## 重复问题',
  avoidance: '## 她的回避',
  memory: '## 记忆现状',
});

/**
 * 裁剪顺序：数字越小越先被砍。
 * 概览放最后砍 —— 08:30 那条汇总完全靠它，砍掉它等于把一天的事实全丢掉。
 */
const SECTION_PRIORITY = Object.freeze({
  memory: 10,
  avoidance: 20,
  repeats: 30,
  anomalies: 40,
  overview: 50,
});

export const DIGEST_DEFAULTS = Object.freeze({
  maxLines: 200,
  /** 单小节最多列几条，防止 300 条异常把预算烧光 */
  maxItemsPerSection: 20,
  /** 每类异常最多列几个证据时间戳 */
  evidenceLimit: 3,
  utcOffsetMinutes: 480,
  /** 重复问题阈值：同 target 在窗口内出现这么多次、且她的回复都这么短 → 视为答偏 */
  repeat: Object.freeze({ minAsks: 3, windowMs: 30 * 60 * 1000, maxChars: 20 }),
  avoidancePhrases: Object.freeze(['不知道', '没听懂', '抱歉', '不清楚']),
  speakingKinds: Object.freeze(['private_reply', 'group_reply', 'proactive']),
});

const pad = (value) => String(value).padStart(2, '0');

/** 本地日期键（YYYY-MM-DD）：审计 at 是 UTC，必须先换算成本地再比。 */
export function localDateKey(ms, utcOffsetMinutes = DIGEST_DEFAULTS.utcOffsetMinutes) {
  const shifted = new Date(ms + utcOffsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 本地某日零点对应的 UTC 毫秒。 */
export function localDayStartUtc(dateKey, utcOffsetMinutes = DIGEST_DEFAULTS.utcOffsetMinutes) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - utcOffsetMinutes * 60_000;
}

/** `UTC+08:00` 这种人读得懂的偏移写法。 */
export function formatOffset(utcOffsetMinutes) {
  const sign = utcOffsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(utcOffsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 证据时间戳统一用 UTC 并带 Z：审计 at 本来就是 UTC，混用本地时间会差 8 小时。 */
export function formatStamp(ms) {
  const at = new Date(ms);
  return `${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}Z`;
}

/**
 * 解析一行审计 JSONL。
 * 半行 JSON（进程被杀时最后一行常常只写了一半）必须被记成坏行，不能静默跳过。
 * @returns `{ ok: true, row }` 或 `{ ok: false }`。
 */
export function parseAuditLine(line) {
  const trimmed = String(line ?? '').trim();
  if (trimmed === '') return { ok: false, empty: true };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  if (typeof parsed.at !== 'string' || typeof parsed.kind !== 'string') return { ok: false };
  const ms = Date.parse(parsed.at);
  if (!Number.isFinite(ms)) return { ok: false };
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  return {
    ok: true,
    row: {
      ms,
      at: parsed.at,
      kind: parsed.kind,
      ok: parsed.ok !== false,
      target: String(parsed.target ?? ''),
      chars: Number.isFinite(parsed.chars) ? parsed.chars : text.length,
      text,
      tier: typeof parsed.tier === 'string' ? parsed.tier : '',
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
    },
  };
}

/**
 * 拆一行 journalctl 输出。
 * bridge / node-plugin 打的是 JSON 行（`{"ts":...,"msg":...,"reason":...}`），
 * 而 pc-agent 之类打的是纯文本，两种都得认。
 */
export function parseJournalLine(line) {
  const raw = String(line ?? '').trimEnd();
  const leading = ISO_STAMP.exec(raw) ?? CLASSIC_STAMP.exec(raw);
  const leadingMs = leading ? Date.parse(leading[0]) : Number.NaN;
  const open = raw.indexOf('{');
  if (open >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(open));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedMs = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN;
        return {
          raw,
          json: parsed,
          stampMs: Number.isFinite(parsedMs) ? parsedMs : leadingMs,
          detail: pickJsondetail(parsed),
        };
      }
    } catch {
      // 半行 JSON 或日志里自带花括号：退回纯文本处理，不丢这一行。
    }
  }
  return { raw, json: null, stampMs: leadingMs, detail: '' };
}

/** 失败原因优先取 reason/error/detail/message，这四个字段覆盖了仓库里的三种日志写法。 */
function pickJsondetail(record) {
  for (const key of ['reason', 'error', 'detail', 'message']) {
    if (typeof record[key] === 'string' && record[key] !== '') return record[key];
  }
  return '';
}

function evidenceOf(entry) {
  if (entry.parsed.stampMs !== undefined && Number.isFinite(entry.parsed.stampMs)) {
    return formatStamp(entry.parsed.stampMs);
  }
  return '无时间戳';
}

/** 命中行的原因摘要：JSON 行取 reason 字段，纯文本行取匹配之后的尾巴。 */
function detailOf(hit) {
  if (hit.parsed.detail !== '') return hit.parsed.detail.replace(/\s+/g, ' ').trim().slice(0, 80);
  const rest = hit.parsed.raw
    .slice(Math.min(hit.match.index + hit.match[0].length, hit.parsed.raw.length))
    .replace(/^[\s:=\-"',]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 纯文本行常常以 JSON 的尾巴收尾，`}` `"` 这类字符留在证据里只会误导读的人。
    .replace(/[\s:=\-"',}\]]+$/, '');
  return rest.slice(0, 80);
}

function scanJournal(journal, pattern) {
  const hits = [];
  for (const entry of journal) {
    const match = pattern.exec(entry.parsed.raw);
    if (match !== null) hits.push({ entry, parsed: entry.parsed, match });
  }
  return hits;
}

function stampsOf(hits, limit) {
  const out = [];
  for (const hit of hits) {
    const stamp = evidenceOf(hit);
    if (stamp === '无时间戳') continue;
    if (out.includes(stamp)) continue;
    out.push(stamp);
    if (out.length >= limit) break;
  }
  return out;
}

/** 一行异常：`- [asr] 转写失败 4 次：原因 —— 证据 时间` */
function anomalyLine({ tag, label, hits, extra = '', evidenceLimit }) {
  const head = `- [${tag}] ${label} ${hits.length} 次${extra}`;
  if (hits.length === 0) return `${head}（日志里没有对应行）`;
  // 第一条命中往往只是 `delivered:false`，原因在紧随其后的那行（NapCat 的 retcode）。
  const withReason = hits.find((hit) => detailOf(hit) !== '') ?? hits[0];
  const detail = detailOf(withReason);
  const stamps = stampsOf(hits, evidenceLimit);
  const reason = detail === '' ? '日志未给出原因' : detail;
  return stamps.length === 0 ? `${head}：${reason} —— 证据 无时间戳` : `${head}：${reason} —— 证据 ${stamps.join(', ')}`;
}

/**
 * 同一 target 在窗口内连问 ≥minAsks 次、且她的回复都 ok 但都很短 → 视为答偏。
 * 用滑动窗口 + 贪心跳跃，保证同一批行只产出一条结论，不刷屏。
 */
function findRepeatProblems(rows, { minAsks, windowMs, maxChars }) {
  const byTarget = new Map();
  for (const row of rows) {
    if (row.target === '') continue;
    const list = byTarget.get(row.target) ?? [];
    list.push(row);
    byTarget.set(row.target, list);
  }
  const found = [];
  for (const [target, list] of byTarget) {
    list.sort((a, b) => a.ms - b.ms);
    let start = 0;
    while (start < list.length) {
      let end = start;
      while (end + 1 < list.length && list[end + 1].ms - list[start].ms <= windowMs) end += 1;
      const run = list.slice(start, end + 1);
      const allSmall = run.every((row) => row.ok === true && row.chars <= maxChars);
      if (run.length >= minAsks && allSmall) {
        found.push({
          target,
          count: run.length,
          firstMs: run[0].ms,
          lastMs: run[run.length - 1].ms,
          maxChars: Math.max(...run.map((row) => row.chars)),
        });
        start = end + 1;
      } else {
        start += 1;
      }
    }
  }
  found.sort((a, b) => a.firstMs - b.firstMs || a.target.localeCompare(b.target));
  return found;
}

function countPhrase(text, phrase) {
  if (text === '' || phrase === '') return 0;
  let count = 0;
  let index = text.indexOf(phrase);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(phrase, index + phrase.length);
  }
  return count;
}

/** 有内容就列，且超过 maxItemsPerSection 时截断并留一行说明。 */
function capped(items, cap, omittedRef) {
  if (items.length <= cap) return items;
  omittedRef.value += items.length - cap;
  return [...items.slice(0, cap), `- …另有 ${items.length - cap} 条未列出（上限每小节 ${cap} 条）`];
}

/**
 * 生成 digest。
 *
 * @param options.date - 服务器本地日期 YYYY-MM-DD。
 * @param options.auditLines - 审计 JSONL 原始行（按月分片的整文件行即可，窗口在这里筛）。
 * @param options.journal - `[{ unit, line }]` 或纯字符串数组。
 * @param options.days - 回溯天数，1 = 每晚，7 = 周度。
 * @param options.maxLines - 行数上限（每晚 200，周度 400）。
 * @param options.memory - `{ path, lines, limit }`，缺席就不写「记忆现状」。
 * @returns `{ markdown, stats }`；stats 是纯数据，formatStats 负责渲染。
 */
export function buildDigest({
  date,
  auditLines = [],
  journal = [],
  days = 1,
  maxLines = DIGEST_DEFAULTS.maxLines,
  maxItemsPerSection = DIGEST_DEFAULTS.maxItemsPerSection,
  evidenceLimit = DIGEST_DEFAULTS.evidenceLimit,
  utcOffsetMinutes = DIGEST_DEFAULTS.utcOffsetMinutes,
  repeat = {},
  avoidancePhrases = DIGEST_DEFAULTS.avoidancePhrases,
  speakingKinds = DIGEST_DEFAULTS.speakingKinds,
  memory = null,
} = {}) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw new TypeError(`date 必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
  }
  if (!Number.isInteger(days) || days < 1) throw new TypeError(`days 必须是正整数，收到 ${JSON.stringify(days)}`);

  const repeatSettings = { ...DIGEST_DEFAULTS.repeat, ...repeat };
  const windowStartMs = localDayStartUtc(date, utcOffsetMinutes) - (days - 1) * 86_400_000;
  const windowEndMs = localDayStartUtc(date, utcOffsetMinutes) + 86_400_000;

  // ---- 审计 ----
  const rows = [];
  let badLines = 0;
  let outsideWindow = 0;
  let emptyLines = 0;
  for (const line of auditLines) {
    if (line !== null && typeof line === 'object') {
      // 已经解析过的行也接受，方便测试与将来的复用。
      const normalized = parseAuditLine(JSON.stringify(line));
      if (normalized.ok) {
        if (normalized.row.ms >= windowStartMs && normalized.row.ms < windowEndMs) rows.push(normalized.row);
        else outsideWindow += 1;
      } else badLines += 1;
      continue;
    }
    const parsed = parseAuditLine(line);
    if (!parsed.ok) {
      if (parsed.empty === true) emptyLines += 1;
      else badLines += 1;
      continue;
    }
    if (parsed.row.ms >= windowStartMs && parsed.row.ms < windowEndMs) rows.push(parsed.row);
    else outsideWindow += 1;
  }
  rows.sort((a, b) => a.ms - b.ms);

  const byKind = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const auditNotOk = rows.filter((row) => row.ok === false).length;
  const auditEmptyReplies = rows.filter((row) => speakingKinds.includes(row.kind) && row.chars === 0).length;
  const auditToolMarkup = rows.filter((row) => TOOL_MARKUP_TEXT.test(row.text ?? '')).length;

  // ---- 日志 ----
  const normalizedJournal = [];
  for (const item of journal) {
    if (typeof item === 'string') normalizedJournal.push({ unit: '', line: item });
    else if (item !== null && typeof item === 'object' && typeof item.line === 'string') {
      normalizedJournal.push({ unit: String(item.unit ?? ''), line: item.line });
    }
  }
  const parsedJournal = normalizedJournal.map((item) => ({ unit: item.unit, parsed: parseJournalLine(item.line) }));
  const units = [...new Set(normalizedJournal.map((item) => item.unit).filter((unit) => unit !== ''))].sort();

  const asrHits = scanJournal(parsedJournal, ASR_PATTERN);
  const deliveryHits = scanJournal(parsedJournal, DELIVERY_PATTERN);
  const declineHits = scanJournal(parsedJournal, PROACTIVE_DECLINE_PATTERN);
  const emptyLogHits = scanJournal(parsedJournal, EMPTY_REPLY_PATTERN);
  const retryHits = scanJournal(parsedJournal, RETRY_PATTERN);
  const askHits = scanJournal(parsedJournal, PROACTIVE_ASK_PATTERN);
  const markupHits = scanJournal(parsedJournal, TOOL_MARKUP_PATTERN);

  // ---- 她的回避 ----
  const avoidanceByPhrase = {};
  const avoidanceExamples = {};
  let avoidanceHits = 0;
  let avoidanceRows = 0;
  for (const row of rows) {
    if (row.text === '') continue;
    let rowHit = false;
    for (const phrase of avoidancePhrases) {
      const count = countPhrase(row.text, phrase);
      if (count === 0) continue;
      rowHit = true;
      avoidanceHits += count;
      avoidanceByPhrase[phrase] = (avoidanceByPhrase[phrase] ?? 0) + count;
      const examples = avoidanceExamples[phrase] ?? [];
      // 审计里没有来信原文，所以只能把 target 与时间摆出来，绝不编句子。
      if (examples.length < evidenceLimit) examples.push({ target: row.target === '' ? '未知' : row.target, stamp: formatStamp(row.ms) });
      avoidanceExamples[phrase] = examples;
    }
    if (rowHit) avoidanceRows += 1;
  }

  const repeats = findRepeatProblems(rows, repeatSettings);
  const omittedRef = { value: 0 };
  const sections = [];

  // ---- 概览 ----
  const overview = [];
  overview.push(`- 窗口 ${date}（服务器本地 ${formatOffset(utcOffsetMinutes)}，共 ${days} 天）`);
  const kindParts = [];
  const proactiveSpoken = rows.filter((row) => row.kind === 'proactive' && row.chars > 0).length;
  const proactiveAsked = askHits.length > 0 ? askHits.length : byKind.proactive ?? 0;
  kindParts.push(`private_reply ${byKind.private_reply ?? 0}`);
  if ((byKind.group_reply ?? 0) > 0) kindParts.push(`group_reply ${byKind.group_reply}`);
  kindParts.push(`proactive ${proactiveAsked} 触发 ${proactiveSpoken} 开口`);
  kindParts.push(`qzone_post ${byKind.qzone_post ?? 0}`);
  if ((byKind.qzone_delete ?? 0) > 0) kindParts.push(`qzone_delete ${byKind.qzone_delete}`);
  if ((byKind.memory_write ?? 0) > 0) kindParts.push(`memory_write ${byKind.memory_write}`);
  overview.push(`- ${kindParts.join(' / ')}`);
  overview.push(
    `- 转写失败 ${asrHits.length}，投递失败 ${deliveryHits.length}，proactive 无话 ${declineHits.length}，空回复（审计 chars:0）${auditEmptyReplies}，重试 ${retryHits.length}`,
  );
  overview.push(
    `- 工具标记：剥离 ${markupHits.length} 次，审计里仍漏出 ${auditToolMarkup} 条`,
  );
  overview.push(
    `- 审计 ${auditLines.length} 行（窗口内 ${rows.length}，窗口外 ${outsideWindow}，坏行 ${badLines}）；日志 ${normalizedJournal.length} 行（${units.length} 个 unit）`,
  );
  sections.push({ key: 'overview', title: SECTION_TITLES.overview, priority: SECTION_PRIORITY.overview, lines: overview });

  // ---- 异常 ----
  const anomalies = [];
  if (asrHits.length > 0 || deliveryHits.length > 0 || declineHits.length > 0 || auditEmptyReplies > 0 || emptyLogHits.length > 0 || auditNotOk > 0 || markupHits.length > 0 || auditToolMarkup > 0) {
    if (markupHits.length > 0 || auditToolMarkup > 0) {
      // 剥离说明出口这道闸在工作；审计里还有才是真漏出去了，要单独骂一句。
      const extra = auditToolMarkup > 0 ? `（审计里仍有 ${auditToolMarkup} 条真漏给对方）` : '';
      if (markupHits.length > 0) {
        anomalies.push(anomalyLine({ tag: 'markup', label: '工具标记被剥离', hits: markupHits, extra, evidenceLimit }));
      } else {
        anomalies.push(`- [markup] 工具标记漏进回复 ${auditToolMarkup} 条（日志里没有 stripped 记录）`);
      }
    }
    if (asrHits.length > 0) {
      anomalies.push(anomalyLine({ tag: 'asr', label: '转写失败', hits: asrHits, evidenceLimit }));
    }
    if (deliveryHits.length > 0 || auditNotOk > 0) {
      const extra = auditNotOk > 0 ? `（另有审计 ok:false ${auditNotOk} 条）` : '';
      if (deliveryHits.length > 0) {
        anomalies.push(anomalyLine({ tag: 'delivery', label: '投递失败', hits: deliveryHits, extra, evidenceLimit }));
      } else {
        anomalies.push(`- [delivery] 日志里没有 delivered:false/retcode 1200，但审计记了 ${auditNotOk} 条 ok:false`);
      }
    }
    if (declineHits.length > 0) {
      anomalies.push(anomalyLine({ tag: 'proactive', label: 'proactive 无话可说', hits: declineHits, evidenceLimit }));
    }
    if (auditEmptyReplies > 0 || emptyLogHits.length > 0) {
      const extra = emptyLogHits.length > 0 ? `（日志 textChars:0 ${emptyLogHits.length} 条，审计 chars:0 ${auditEmptyReplies} 条）` : '';
      const hits = emptyLogHits.length > 0 ? emptyLogHits : [];
      if (hits.length > 0) {
        anomalies.push(anomalyLine({ tag: 'empty', label: '空回复', hits, extra, evidenceLimit }));
      } else {
        anomalies.push(`- [empty] 空回复 ${auditEmptyReplies} 条（审计 chars:0）`);
      }
    }
  }
  sections.push({
    key: 'anomalies',
    title: SECTION_TITLES.anomalies,
    priority: SECTION_PRIORITY.anomalies,
    lines: capped(anomalies, maxItemsPerSection, omittedRef),
  });

  // ---- 重复问题 ----
  const repeatLines = repeats.map(
    (item) =>
      `- ${item.target} 连问 ${item.count} 次（${formatStamp(item.firstMs)}–${formatStamp(item.lastMs)}），她每次都 ok 且都 ≤${item.maxChars} 字：疑似答偏`,
  );
  sections.push({
    key: 'repeats',
    title: SECTION_TITLES.repeats,
    priority: SECTION_PRIORITY.repeats,
    lines: capped(repeatLines, maxItemsPerSection, omittedRef),
  });

  // ---- 她的回避 ----
  const avoidanceLines = [];
  for (const phrase of avoidancePhrases) {
    const count = avoidanceByPhrase[phrase] ?? 0;
    if (count === 0) continue;
    const examples = (avoidanceExamples[phrase] ?? []).map((item) => `target ${item.target} @ ${item.stamp}`).join('、');
    avoidanceLines.push(`- 「${phrase}」${count} 次：${examples}`);
  }
  if (avoidanceLines.length > 0) avoidanceLines.push('- 审计不含来信原文，只列 target 与时间。');
  sections.push({
    key: 'avoidance',
    title: SECTION_TITLES.avoidance,
    priority: SECTION_PRIORITY.avoidance,
    lines: capped(avoidanceLines, maxItemsPerSection, omittedRef),
  });

  // ---- 记忆现状 ----
  const memoryLines = [];
  if (memory !== null && memory !== undefined) {
    const limit = Number.isFinite(memory.limit) ? memory.limit : 60;
    const lineCount = Number.isFinite(memory.lines) ? memory.lines : 0;
    const over = lineCount > limit ? `（已超限 ${lineCount - limit} 行）` : '';
    memoryLines.push(`- MEMORY.md ${lineCount} 行 / 上限 ${limit}${over}`);
  }
  sections.push({
    key: 'memory',
    title: SECTION_TITLES.memory,
    priority: SECTION_PRIORITY.memory,
    lines: capped(memoryLines, maxItemsPerSection, omittedRef),
  });

  // ---- 组装与裁剪 ----
  const header = [`# 夜班素材 ${date}`];
  const renderLines = (list) => {
    const out = [...header];
    for (const section of list) {
      if (section.lines.length === 0) continue;
      out.push('', section.title, ...section.lines);
    }
    return out;
  };

  const working = sections.map((section) => ({ ...section, lines: [...section.lines] }));
  const baseTotal = renderLines(working).length;
  let trimmed = 0;
  const trimStep = () => {
    const candidates = working
      .filter((section) => section.lines.length > 0 && section.priority < SECTION_PRIORITY.overview)
      .sort((a, b) => a.priority - b.priority);
    const victim = candidates[0];
    if (victim === undefined) return false;
    victim.lines.pop();
    if (victim.lines.length === 0) working.splice(working.indexOf(victim), 1);
    return true;
  };

  while (renderLines(working).length > maxLines) {
    if (!trimStep()) break;
  }

  let finalLines = renderLines(working);
  let noteAdded = false;
  trimmed = baseTotal - finalLines.length;
  if (trimmed > 0) {
    const order = working.map((section) => section.title.replace('## ', '')).reverse().join(' → ');
    const note = `- 已按 ${maxLines} 行上限裁剪 ${trimmed} 行（先砍 ${order}）`;
    const overviewSection = working.find((section) => section.key === 'overview');
    overviewSection.lines.push(note);
    noteAdded = true;
    while (renderLines(working).length > maxLines) {
      if (!trimStep()) break;
    }
    finalLines = renderLines(working);
  }
  trimmed = baseTotal + (noteAdded ? 1 : 0) - finalLines.length;
  if (trimmed < 0) trimmed = 0;

  const stats = {
    date,
    days,
    maxLines,
    weekly: days > 1,
    utcOffsetMinutes,
    windowStartIso: new Date(windowStartMs).toISOString(),
    windowEndIso: new Date(windowEndMs).toISOString(),
    audit: {
      linesRead: auditLines.length,
      inWindow: rows.length,
      outsideWindow,
      badLines,
      emptyLines,
      byKind,
      notOk: auditNotOk,
      emptyReplies: auditEmptyReplies,
    },
    journal: {
      lines: normalizedJournal.length,
      units,
      asrFailures: asrHits.length,
      deliveryFailures: deliveryHits.length,
      proactiveDeclines: declineHits.length,
      emptyReplies: emptyLogHits.length,
      retries: retryHits.length,
      proactiveAsks: askHits.length,
      toolMarkupStrips: markupHits.length,
      toolMarkupLeaks: auditToolMarkup,
    },
    proactive: { asked: proactiveAsked, spoken: proactiveSpoken },
    avoidance: { hits: avoidanceHits, rows: avoidanceRows, byPhrase: avoidanceByPhrase, phrases: [...avoidancePhrases] },
    repeatIssues: repeats.map((item) => ({ ...item, firstStamp: formatStamp(item.firstMs), lastStamp: formatStamp(item.lastMs) })),
    repeatSettings,
    memory: memory === null || memory === undefined ? null : { ...memory },
    renderedLines: finalLines.length,
    trimmedLines: trimmed,
    itemsOmitted: omittedRef.value,
  };

  return { markdown: `${finalLines.join('\n')}\n`, stats };
}

/** stats 的可读渲染；早上那条私聊与排查都读它。 */
export function formatStats(stats) {
  const lines = [`# 夜班计数 ${stats.date}`, ''];
  lines.push('## 窗口');
  lines.push(`- 日期 ${stats.date}（服务器本地 ${formatOffset(stats.utcOffsetMinutes)}），共 ${stats.days} 天`);
  lines.push(`- UTC 窗口 ${stats.windowStartIso} → ${stats.windowEndIso}`);
  lines.push('');
  lines.push('## 审计');
  lines.push(
    `- 读入 ${stats.audit.linesRead} 行，窗口内 ${stats.audit.inWindow}，窗口外 ${stats.audit.outsideWindow}，坏行 ${stats.audit.badLines}`,
  );
  const kindEntries = Object.entries(stats.audit.byKind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push(`- 按 kind：${kindEntries.length === 0 ? '（窗口内没有审计行）' : kindEntries.map(([kind, count]) => `${kind} ${count}`).join(' / ')}`);
  lines.push(`- ok:false ${stats.audit.notOk} 条，空回复（chars:0）${stats.audit.emptyReplies} 条`);
  lines.push('');
  lines.push('## 日志');
  lines.push(
    `- ${stats.journal.lines} 行，${stats.journal.units.length} 个 unit：${stats.journal.units.length === 0 ? '（无）' : stats.journal.units.join(', ')}`,
  );
  lines.push(
    `- 转写失败 ${stats.journal.asrFailures} / 投递失败 ${stats.journal.deliveryFailures} / proactive 无话 ${stats.journal.proactiveDeclines} / 空回复 ${stats.journal.emptyReplies} / 重试 ${stats.journal.retries} / proactive 询问 ${stats.journal.proactiveAsks} / 工具标记剥离 ${stats.journal.toolMarkupStrips}（漏出 ${stats.journal.toolMarkupLeaks}）`,
  );
  lines.push('');
  lines.push('## 异常汇总');
  lines.push(`- proactive ${stats.proactive.asked} 触发 ${stats.proactive.spoken} 开口`);
  lines.push(`- 回避命中 ${stats.avoidance.hits} 次（落在 ${stats.avoidance.rows} 条回复里）`);
  if (stats.repeatIssues.length === 0) {
    lines.push('- 重复问题 0 组');
  } else {
    lines.push(`- 重复问题 ${stats.repeatIssues.length} 组`);
    for (const item of stats.repeatIssues) {
      lines.push(`  - ${item.target} 连问 ${item.count} 次（${item.firstStamp}–${item.lastStamp}），最长 ${item.maxChars} 字`);
    }
  }
  lines.push(
    `- 重复问题阈值：同 target ${stats.repeatSettings.minAsks} 次 / ${Math.round(stats.repeatSettings.windowMs / 60_000)} 分钟内 / 回复 ≤${stats.repeatSettings.maxChars} 字`,
  );
  if (stats.memory !== null) {
    lines.push(`- MEMORY.md ${stats.memory.lines} 行 / 上限 ${stats.memory.limit}${stats.memory.path ? `（${stats.memory.path}）` : ''}`);
  }
  lines.push('');
  lines.push('## 产出');
  lines.push(`- digest 行数 ${stats.renderedLines} / 上限 ${stats.maxLines}（裁剪 ${stats.trimmedLines} 行）`);
  lines.push(`- 单小节条数上限 ${DIGEST_DEFAULTS.maxItemsPerSection}，本次省略 ${stats.itemsOmitted} 条`);
  return `${lines.join('\n')}\n`;
}
