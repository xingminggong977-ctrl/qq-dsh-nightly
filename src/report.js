/**
 * 08:30 那条私聊：把 digest + stats + 提案目录压成 ≤600 字的中文。
 *
 * 拼装是纯函数，发送才碰网络 —— 这样「600 字上限」与「桥接挂了不崩」
 * 都能在开发机上被测到，不需要一台真的服务器。
 */

export const REPORT_DEFAULTS = Object.freeze({
  maxChars: 600,
  maxBullets: 12,
  /** 只从这两节里取要点：概览给数字，异常给事实。 */
  sections: Object.freeze(['## 概览', '## 异常']),
  /** 契约点名的路由。 */
  endpoint: '/node/send',
  timeoutMs: 10_000,
});

/**
 * ⚠ 已知缺口：截至写这份代码时 bridge/src/http.js 里**没有** `/node/send` 路由。
 * 实际存在的 node 出口只有 /node/poll、/node/status、/node/result、
 * /node/send_image、/node/pc/*，以及 /blob/<id>。
 * 所以这里的请求体不是猜的，是照抄唯一一个既有的「发东西出去」的路由
 * /node/send_image 的字段命名（`kind` 取 'private' | 'group'，`to` 是 QQ 号），
 * 只把 `file` 换成 `text`：
 *
 *   { "kind": "private", "to": "10001", "text": "…" }
 *
 * 桥接补上 /node/send 时，字段应当与这个形状一致；若届时改名，
 * 只需要改 SEND_BODY_KEYS 一处，测试会把这个形状钉住。
 */
export const SEND_BODY_KEYS = Object.freeze(['kind', 'to', 'text']);

/** 从 digest markdown 里按 `## 小节` 抽要点，遇到下一个小节就停。 */
export function extractBullets(markdown, sections = REPORT_DEFAULTS.sections) {
  const lines = String(markdown ?? '').split('\n');
  const out = [];
  let active = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      active = sections.includes(line.trim());
      continue;
    }
    if (!active) continue;
    if (line.startsWith('- ')) out.push(line.trim());
  }
  return out;
}

/** 从 stats markdown 里挑一行（按包含关系），挑不到就返回空串。 */
export function pickStatsLine(statsMarkdown, needle) {
  for (const raw of String(statsMarkdown ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ') && line.includes(needle)) return line;
  }
  return '';
}

const charCount = (text) => [...text].length;

/**
 * 拼一条 ≤maxChars 的私聊。
 *
 * 裁剪顺序是「先丢中间的异常细节，再丢最后一行路径」，因为头部的数字
 * 与提案才是他早上真正会看的东西；全砍完还超就硬截断，绝不发出超长消息
 * （QQ 单条有上限，超了会静默截断，那等于把信息扔了还不知道）。
 */
export function buildReportMessage({
  date,
  digest = '',
  stats = '',
  proposals = [],
  digestPath = '',
  maxChars = REPORT_DEFAULTS.maxChars,
  maxBullets = REPORT_DEFAULTS.maxBullets,
} = {}) {
  if (typeof date !== 'string' || date === '') throw new TypeError('date 必填');

  const head = `【夜班 ${date}】`;
  const bullets = extractBullets(digest).slice(0, maxBullets);
  const proposalLine =
    proposals.length === 0 ? '提案 0 条' : `提案 ${proposals.length} 条：${proposals.slice(0, 3).join('、')}${proposals.length > 3 ? '…' : ''}`;
  const statsLine = pickStatsLine(stats, 'digest 行数');
  const tail = [statsLine, proposalLine, digestPath === '' ? '' : `完整清单：${digestPath}`].filter((line) => line !== '');

  const assemble = (list) => [head, ...list, ...tail].join('\n');
  let body = [...bullets];
  let text = assemble(body);
  let truncated = false;
  while (charCount(text) > maxChars && body.length > 0) {
    body.pop();
    text = assemble(body);
    truncated = true;
  }
  if (charCount(text) > maxChars) {
    const hard = [...text].slice(0, Math.max(1, maxChars - 1)).join('').trimEnd();
    text = `${hard}…`;
    truncated = true;
  }
  return { text, chars: charCount(text), truncated };
}

/**
 * 发一条私聊。永不抛 —— 桥接挂了是常态（重启、NapCat 掉线、端口没起来），
 * 早上 08:30 的任务不能因为对端不在就吐一屏堆栈。
 *
 * @returns `{ ok, status, endpoint, body, error }`；ok=false 时 status=0 表示网络层就失败了。
 */
export async function postPrivateText({
  url,
  token,
  to,
  text,
  endpoint = REPORT_DEFAULTS.endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = REPORT_DEFAULTS.timeoutMs,
  log = () => {},
} = {}) {
  if (typeof url !== 'string' || url === '') {
    log('error', 'BRIDGE_URL 为空，晨报没发出去');
    return { ok: false, status: 0, endpoint, body: null, error: 'BRIDGE_URL 为空' };
  }
  if (typeof token !== 'string' || token === '') {
    log('error', 'NODE_TOKEN 为空，晨报没发出去');
    return { ok: false, status: 0, endpoint, body: null, error: 'NODE_TOKEN 为空' };
  }
  if (typeof to !== 'string' || !/^\d{5,12}$/.test(to)) {
    log('error', `收件 QQ 号不合法：${JSON.stringify(to)}`);
    return { ok: false, status: 0, endpoint, body: null, error: '收件 QQ 号不合法' };
  }
  if (typeof fetchImpl !== 'function') {
    log('error', '当前运行时没有可用的 fetch');
    return { ok: false, status: 0, endpoint, body: null, error: '没有可用的 fetch' };
  }

  const target = `${String(url).replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const payload = { kind: 'private', to, text };
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    // 连接被拒、超时、DNS 挂了都从这里出：一行日志 + 非 0 退出码，没有堆栈。
    const message = error?.message ?? String(error);
    log('error', `晨报发送失败（桥接不可达）：${message}`);
    return { ok: false, status: 0, endpoint, body: null, error: message };
  }

  let body = null;
  let raw = '';
  try {
    raw = await response.text();
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    body = null;
  }
  if (response.status === 404) {
    log(
      'error',
      `桥接返回 404：${target} 没有这个路由。当前 bridge/src/http.js 只有 /node/poll、/node/status、/node/result、/node/send_image —— 需要桥接补上 /node/send（见 nightly/README.md「已知缺口」）。`,
    );
    return { ok: false, status: 404, endpoint, body, error: 'route not found' };
  }
  if (!response.ok) {
    log('error', `晨报发送失败：HTTP ${response.status} ${raw.slice(0, 200)}`.trimEnd());
    return { ok: false, status: response.status, endpoint, body, error: `HTTP ${response.status}` };
  }
  if (body !== null && body.ok === false) {
    log('error', `晨报发送失败：桥接回了 ok:false ${raw.slice(0, 200)}`.trimEnd());
    return { ok: false, status: response.status, endpoint, body, error: 'bridge rejected' };
  }
  log('info', `晨报已发（${charCount(text)} 字）→ ${target}`);
  return { ok: true, status: response.status, endpoint, body, error: '' };
}
