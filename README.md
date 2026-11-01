# dsh-qq 夜班 · 零 token 那一半

`nightly/` 只做两件事：**读**审计流水与 journald 日志，**数**出昨晚发生了什么。
一次模型都不调 —— 记忆的写入、提案的生成、复盘轮次都在 node-plugin 侧（03:10），
这里只负责供货。

契约见 `docs/nightly-contract.md`（三端共用），本组件的产出格式以那份为准。

## 目录

```
nightly/
├── bin/nightly-digest.mjs     03:00 采集 → digest-YYYY-MM-DD.md + stats-YYYY-MM-DD.md
├── bin/morning-report.mjs     08:30 读 digest+stats+提案 → 一条 ≤600 字私聊
├── src/digest.js              纯函数：解析、计数、裁剪（不读时钟、不读文件）
├── src/collect.js             唯一有副作用的一层：读分片、跑 journalctl（执行器可注入）
├── src/report.js              晨报拼装（纯）与发送（永不抛）
├── systemd/                   三个 oneshot service + 三个 timer
└── test/                      node:test 用例与夹具
```

## 装上（在服务器上，由部署方执行）

本组件不会自己部署、不碰线上任何东西。

1. 放进 `/opt/dsh-qq-agent/nightly/`。
2. 确认 node ≥ 24：`command -v node`。三个 `.service` 里的 `ExecStart=/usr/bin/node` 要按结果改
   （npmmirror 装法给的是 `/usr/local/bin/node`）。
3. `mkdir -p /var/lib/dsh-qq-agent/nightly`（digest 落这里）。
4. 写 `/etc/dsh-qq-nightly/env`（`-` 前缀让 unit 在文件不存在时也能起，缺 token 由脚本自己报）：

   ```
   NODE_TOKEN=<桥接的 nodeToken>
   OWNER_QQ=10001
   BRIDGE_URL=http://127.0.0.1:8787
   ```

5. `cp systemd/dsh-qq-nightly-*.service systemd/dsh-qq-nightly-*.timer /etc/systemd/system/ && systemctl daemon-reload`
6. `systemctl enable --now dsh-qq-nightly-digest.timer dsh-qq-nightly-report.timer dsh-qq-nightly-weekly.timer`
7. 验证：`systemctl list-timers 'dsh-qq-nightly*'`，日志在 `/var/log/dsh-qq-nightly.log`。

## dry-run（本机就能跑完）

```bash
cd nightly
node --test "test/**/*.test.js"        # Windows 上用 npm.cmd test

# 用夹具造一份 digest 打到 stdout，不写任何文件
node bin/nightly-digest.mjs --date=2026-05-14 --audit-dir=test/fixtures \
  --memory-file=/nope/MEMORY.md --dry-run

# 写到本地临时目录，看看真实文件名与 stats
node bin/nightly-digest.mjs --date=2026-05-14 --audit-dir=test/fixtures --out-dir=/tmp/nightly

# 晨报只拼不发
node bin/morning-report.mjs --date=2026-05-14 --out-dir=/tmp/nightly --dry-run
```

`--memory-file` 指一个不存在的路径是有意的：验证「读不到 MEMORY.md 只 warn、不崩」。

服务器上 dry-run 一条：`/usr/bin/node bin/nightly-digest.mjs --dry-run | head -40`。
本机没有 journalctl 时会打一行 warn 然后照常出 digest —— 这正是「命令不在也不能崩」的那条路径。

## 参数

`nightly-digest.mjs`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--date=YYYY-MM-DD` | 服务器本地今天 | 要生成哪天的素材 |
| `--out-dir=PATH` | `/var/lib/dsh-qq-agent/nightly` | digest/stats 输出目录 |
| `--audit-dir=PATH` | `/opt/dsh-qq-agent/audit` | 审计分片目录（按 UTC 月分片） |
| `--memory-file=PATH` | `/opt/dsh-qq-agent/persona/MEMORY.md` | 只数行数 |
| `--memory-limit=N` | `60` | 契约上限，超了在 digest 里标红 |
| `--days=N` | `1`（`--weekly` 时 `7`） | 回溯天数 |
| `--max-lines=N` | `200`（`--weekly` 时 `400`） | digest 行数上限 |
| `--utc-offset-minutes=N` | `480` | 服务器本地时区偏移（Asia/Shanghai） |
| `--weekly` | 关 | 周度档：7 天 + 400 行 + `-weekly` 文件名后缀 |
| `--suffix=TEXT` | 空 | 单独指定文件名后缀 |
| `--dry-run` | 关 | 只打到 stdout |

`morning-report.mjs`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--date` / `--out-dir` | 同 digest | 读哪天的素材 |
| `--proposals-dir=PATH` | `/opt/dsh-qq-agent/proposals` | 会读 `<dir>/<date>/*.patch` |
| `--to=QQ号` | `OWNER_QQ`，其次 `ALERT_QQ` | 收件人（`OWNER_QQ` 有多个时取第一个） |
| `--max-chars=N` | `600` | 私聊字数上限 |
| `--dry-run` | 关 | 只打正文，不发 |

只在 `--dry-run` 之外读环境变量：`NODE_TOKEN`（必填）、`BRIDGE_URL`（默认 `http://127.0.0.1:8787`）。

## 退出码

| 码 | 含义 | 要不要管 |
| --- | --- | --- |
| 0 | 正常 | — |
| 1 | 采集或发送失败（桥接不可达、digest 没生成） | 看一行日志，必要时手工重跑 |
| 2 | 参数或配置问题（缺 token、缺收件人、参数写错） | 改配置 |

## 关掉

- **软件层（即时生效，推荐）**：node-plugin 配置里 `nightlyEnabled: false`。
  digest 仍会生成（它不花钱），但夜里不会有任何模型轮次。
- **systemd 层（彻底停）**：
  ```bash
  systemctl disable --now dsh-qq-nightly-digest.timer dsh-qq-nightly-report.timer dsh-qq-nightly-weekly.timer
  ```
- 只停一天：`systemctl stop dsh-qq-nightly-report.timer`（下次开机/daemon-reload 会重新排程）。

## 已知缺口：桥接没有 `/node/send`

`bridge/src/http.js` 的鉴权覆盖 `/node/*`，但实际注册的路由只有
`/health`、`/node/poll`、`/node/status`、`/node/result`、`/node/send_image`、`/node/pc/*`、`/blob/<id>`。
**没有 `/node/send`**，所以晨报现在会收到 404。

按既有约定推断的请求体（照抄 `/node/send_image` 的字段命名，只把 `file` 换成 `text`）：

```json
{ "kind": "private", "to": "10001", "text": "【夜班 2026-05-14】…" }
```

鉴权头是 `Authorization: Bearer <NODE_TOKEN>`（`bridge/src/http.js` 的 `authorized()` 只认这一种）。
桥接补上这个路由时，字段若与上面不同：改 `src/report.js` 的 `SEND_BODY_KEYS` 与 `payload` 一处，
`test/report.test.js` 里「请求体字段就是 SEND_BODY_KEYS」会跟着红。
在补上之前：404 → 日志一行「需要桥接补上 /node/send」→ 退出码 1，不崩、不假装成功。

## 与契约的一处偏差：周度文件名

契约写 digest 落在 `digest-YYYY-MM-DD.md`。周度与日度同在 03:00 触发，
若同名会互相覆盖，而 03:10 的复盘只读日度那份 —— 所以 `--weekly` 写
`digest-YYYY-MM-DD-weekly.md` / `stats-YYYY-MM-DD-weekly.md`，两份都留得住。
若希望周度覆盖同名文件，把 `bin/nightly-digest.mjs` 里 `suffix` 那一行改成 `''`，或运行时传 `--suffix=`。

同理，晨报读的始终是日度那份 `digest-YYYY-MM-DD.md`。

## 时间表（服务器本地时间）

| 时刻 | unit | 干什么 |
| --- | --- | --- |
| 03:00 | `dsh-qq-nightly-digest.timer` | 生成日度 digest + stats |
| 03:00 周日 | `dsh-qq-nightly-weekly.timer` | 生成周度 digest + stats（7 天 / 400 行） |
| 03:10 | *（node-plugin）* | 读 digest，复盘轮次、写记忆、落提案 |
| 08:30 | `dsh-qq-nightly-report.timer` | 一条 ≤600 字私聊发给主人 |

## 日志与容错

全部追加到 `/var/log/dsh-qq-nightly.log`，每行以 ISO 时间戳 + `info|warn|error` 开头。
读文件失败、`journalctl` 不在或退出码非 0、提案目录不存在，都会留下一行可读原因
（`ENOENT` / `EACCES` / `退出码 N`），不会静默吞掉 —— 2026 年那次 `/home/dshqq` 没建导致转写挂了一整天，
就是因为没人能一眼看到「目录不存在」。
