# dsh-remote 技术文档

> **English summary** — Architecture and maintenance guide. The host plugin
> (`lib/index.js`) reads a v2 multi-server config (`remote-servers.json`,
> lookup: `DSH_REMOTE_CONFIG` → `$DSH_HOME` → cwd → session cwd → legacy
> `remote-agent.json`), talks plain HTTP to a zero-dependency Node agent on the
> target server, and keeps one persistent bash session per (agent, server)
> driven by a stderr-marker wrapper protocol. Binary upload/download bypasses
> the text-only fs service and mirrors the fs-sandbox fence locally.

本文档面向后续维护者（人或 AI Agent），描述 dsh-remote 的架构、协议、实现细节、维护与拓展方法。
最后更新：2026-08-15（对应 v1.2.0）。

---

## 1. 概述

dsh-remote 提供对**远程服务器**的运维控制能力：在远程服务器上运行一个常驻 Agent
（零依赖 Node 程序），本机通过 HTTP 协议调用。提供 5 个模型工具 + 1 个 GUI 设置页：

| 工具 | 用途 |
|---|---|
| `remote_bash` | 持久 bash 会话（cwd/变量/后台任务跨调用保持，按 服务器×会话 隔离） |
| `remote_exec` | 一次性执行命令（无状态） |
| `remote_upload` | 本地上传文件到服务器（文本 + 二进制，单文件 ≤ 100 MiB） |
| `remote_download` | 从服务器下载文件到本地（文本 + 二进制，逐字节保留） |
| `remote_health` | 检查 Agent 连通性 |

所有工具支持可选 `server` 参数（服务器别名），缺省使用默认服务器。

---

## 2. 架构

```
浏览器 GUI（settings.section → 远程连接）
   │  fetch POST /remote-agent/api   （webServer 路由，host 进程内）
   ▼
dsh-remote host 插件（本机 dsh 进程内）
   │  HTTP（Bearer token）
   ▼
远程 Agent（服务器上 /opt/dsh-agent/agent.mjs，零依赖 node:http）
   │  spawn
   ▼
bash --noprofile --norc -s（/bin/bash，管道 stdio）
```

- **包结构**：`lib/index.js`（host 插件）+ `lib/client.js`（浏览器插件）+ package.json 的
  `dsh.client` 声明。clientModules 在启动时扫描 Loader 条目中声明 `dsh.client` 的包并服务
  `/plugins/<id>/client.js`。
- **GUI 与 host 通信**：不走 harness RPC，走 `webServer.register` 的 HTTP 路由
  `/remote-agent/api`（POST JSON，op 分发），与 `@dsh-user/dsh-mcp-manager` 同一模式。

---

## 3. 配置格式（v2，多服务器）

权威文件：**`~/.dsh/remote-servers.json`**（DSH 全局层，任何工作区/会话共享）。

```json
{
  "version": 2,
  "default": "aliyun-main",
  "servers": [
    { "name": "aliyun-main", "host": "8.163.12.206", "port": 28431, "token": "…" }
  ]
}
```

- `name`：别名，`[A-Za-z0-9_-]{1,32}`，工具 `server` 参数按它选择。
- `default`：缺省服务器别名；不存在时回退到列表第一个。
- `token`：服务器 Agent 的 `DSH_AGENT_TOKEN`。

### 读取顺序（第一个命中即用）

1. `DSH_REMOTE_CONFIG` 环境变量指向的文件
2. `$DSH_HOME/remote-servers.json`
3. 进程 cwd `remote-servers.json`
4. 会话工作区 `remote-servers.json`
5. 兼容旧格式：`$DSH_HOME/remote-agent.json` → cwd → 会话工作区（单服务器对象，自动迁移为别名 `default`）

每次工具调用都重新读取（保存即生效，无需重启）。

### GUI 保存位置

`save` op 写入：`$DSH_HOME/remote-servers.json`（权威）→ 进程 cwd 副本。其余位置只读不写。

---

## 4. 远程 Agent 协议

Agent 源码在本仓库 `agent/agent.mjs`（部署材料同目录：`agent.env.example`、`dsh-agent.service`）。

| 端点 | 说明 |
|---|---|
| `GET /health` | `{"ok":true,"version":1,"uptime":s}`，无鉴权 |
| `POST /exec` | body `{"cmd","timeoutMs"?,"cwd"?}`；chunked 流式输出，结尾 `\n[exit:<code>]\n` |
| `POST /shell` | 建持久 bash 会话；响应头 `x-session: <id>`，响应体流式推送合并的 stdout+stderr |
| `POST /shell/input?id=` | body = 原始字节，写入会话 stdin |
| `POST /shell/kill?id=` | 终止会话进程树 |
| `GET /download?path=` | 文件字节流（application/octet-stream） |
| `POST /upload?path=` | body = 文件字节（二进制安全，Agent 直接落盘） |

除 `/health` 外均需 `Authorization: Bearer <token>`（`crypto.timingSafeEqual` 比较）。

**持久 shell 协议**（客户端驱动，与 dsh-winfix 相同）：命令包装为一行——

```
printf '%s\n' START >&2; eval -- $'…' >&2; __s=$?; printf '%s%s\n' END "$__s" >&2; /usr/bin/sleep 0 >/dev/null 2>&1
```

- 标记走 stderr（无缓冲），命令输出重定向 `>&2` 避免 bash 管道 stdout 缓冲陷阱，尾部外部命令强制 flush。
- 客户端按 (agent, 服务器) 维护会话；断线（404/410）自动重建并重试一次；300s 超时重置会话。

### 服务器端已知约束

- Windows 上 ACL 受限令牌无法启动 Git Bash（0xC0000142），故本地 bash 不沙箱（见 dsh-winfix 文档）；
  远程 Agent 以专用用户 `dshagent` 运行，属于"账号级"隔离而非 OS 沙箱。
- Agent 的 `/shell` 是 bash 非交互管道模式：交互式 TTY 程序（vim/top/密码提示）不可用。

---

## 5. 宿主实现细节（lib/index.js）

### 5.1 工具注册

5 个工具用官方 `defineTool` 注册（本插件 profile 层有 `@deepseek-ai` 依赖树，与
mcp-manager 的"零 import"不同——那是由于 profile 解析域差异，见 mcp-manager 文档 §4）。

- 工具 `execute(args, exec)` 里通过 `exec.agent.session.header.cwd` 取会话工作区，
  用于解析相对路径与配置查找顺序。
- `presentCall` 提供调用卡片展示（terminal / generic）。

### 5.2 HTTP 客户端

`apiRequest(cfg, method, path, body, timeoutMs)` 用 `node:http` 直连：
- `Authorization: Bearer <token>`；
- 字符串 body → `content-type: text/plain`；Buffer body → `application/octet-stream`；
- 超时 `req.destroy`。

### 5.3 本地二进制写入与沙箱围栏镜像

fs 服务只写 UTF-8 文本，二进制下载需要原始字节写入（`writeFileSync`），因此在插件内**镜像
fs-sandbox 围栏**：

- `read-only` → 拒绝；
- `workspace-write` → 只允许工作区根与临时目录（`tmpdir()`、`/tmp`）内的目标；
- `danger-full-access` → 不限制。

`assertWritableTarget(target, exec)` 通过 `ctx.get('sandboxPolicy').resolve(...)` 取模式。

### 5.4 持久 shell 会话管理

- `sessions` = `Map<serverName, Map<ownerAgent, state>>`；state 含 `sid/buffer/pending/dead/queue`。
- 命令经 `quoteForBash` 转义 + `wrapCommand` 包装（stderr 标记协议）；`nonce()` 生成唯一
  START/END 标记，避免并发/残留输出串扰。
- `appendBuffer` 维护 2 MiB 滚动缓冲，命中 END 标记即 resolve 本次调用；输出经
  `sanitizeTerminal` 去 ANSI、`maybeTruncate` 截断（16k 字符）。
- 并发调用按 owner 串行化（`st.queue`）；单次调用 300s 超时自动重置会话；插件停止时
  `ctx.effect` 清理所有会话（`/shell/kill` best-effort）。

### 5.5 GUI API（/remote-agent/api）

ops：`list` / `save`（entry + setDefault）/ `remove`（name）/ `test`（name 或 entry）。
`save` 写权威文件 + cwd 副本；`test` 走 `/health` 并解析 uptime。

> 安全注：该路由**无鉴权**（与 mcp-manager 相同）；webserver 默认 127.0.0.1，
> 改绑 0.0.0.0 时需自行加鉴权。

---

## 6. 客户端实现细节（lib/client.js）

- 与 mcp-manager 相同的 `__ModuleLoader__.load({ id: 'dsh-remote', factory })` bundle 形态；
  `require('react')` 来自 shell seed 表。
- 注册 `settings.section`（id `remote-agent`，order 30）→ 设置 → 「远程连接」。
- 页面能力：服务器列表（别名/地址/默认徽标）、新增/编辑/删除、测试连接、设为默认、
  「怎么在服务器上配置」教程（内嵌 `GUIDE_HTML`，7 步：Node → 用户 → 部署+令牌 →
  systemd → 放行端口 → 验证 → 回本页添加）。
- Token 在编辑表单中回传并显示为密码框（本地 GUI，风险可控）。

---

## 7. 维护与扩展

### 7.1 新增服务器

1. 在服务器上部署 Agent（GUI 内「怎么在服务器上配置」教程；或直接用 SSH 部署）。
2. GUI「+ 新增服务器」填写并测试；或直接编辑 `~/.dsh/remote-servers.json`。

### 7.2 常见故障排查

| 现象 | 排查 |
|---|---|
| 工具报"未知服务器" | 别名拼写；`readServers` 读取顺序；配置文件 JSON 是否合法 |
| 401/连接失败 | token 与服务器 `agent.env` 是否一致；安全组/防火墙是否放行；`curl http://<ip>:<port>/health` |
| 持久会话丢失 | Agent 重启（systemd 自动拉起）；客户端 404 自动重建 |
| 命令无输出挂起 | 确认 Agent 日志 `journalctl -u dsh-agent`；bash -s 管道模式下 TTY 程序不可用 |

### 7.3 改 Agent（agent.mjs）

改完 scp 到 `/opt/dsh-agent/` 后 `systemctl restart dsh-agent`
（协议兼容性：host 端不感知 Agent 版本，只认上述端点）。

### 7.4 扩展思路

- 多 Agent 路由、按别名分组：改 `remote-servers.json` 加字段 + host 解析逻辑。
- 传输加密：Agent 挂自签 TLS（node:https），GUI 支持协议前缀。
- 超大文件：单文件上限 100 MiB（host 端 `readBytes` 上限 + Agent 端 `MAX_BODY`，两处需同步放宽）。

---

## 8. 版本历史

- 1.0.0：单服务器，配置文件 remote-agent.json，工具无 server 参数。
- 1.1.0：多服务器 + 别名 + `server` 参数 + 全局配置（DSH_HOME）+ GUI 设置页 + 旧格式兼容。
- 1.2.0：`remote_upload` / `remote_download` 改为原始字节通道，支持图片、压缩包等二进制文件
  （此前仅文本）；本地下载写入镜像 fs-sandbox 沙箱围栏（read-only 拒绝 / workspace-write 限
  工作区与临时目录 / danger-full-access 不限制）。
