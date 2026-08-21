# dsh-remote

> [!WARNING]
> **AI 生成声明 / AI-Generated Notice**
> 本项目（代码与文档）由 AI 辅助生成，仅供个人学习、参考与二次开发使用。
> 请在使用前自行审查代码的安全性，作者不对使用本项目造成的任何后果负责。
> This project (code & docs) was AI-assisted. Use at your own risk; review before use.

> **English summary** — A DSH (DeepSeek Harness) plugin for remote server
> operations. A zero-dependency Node agent runs on the target server; the local
> plugin exposes five model tools (`remote_bash`, `remote_exec`,
> `remote_upload`, `remote_download`, `remote_health`) plus a settings UI
> ("远程连接"). Multi-server support via aliases; config in
> `~/.dsh/remote-servers.json` (v2). This repo also ships the server-side
> agent (`agent/agent.mjs`) and its systemd unit.

DSH（DeepSeek Harness）远程连接插件：在远程服务器上运行一个常驻 Agent（零依赖 Node 程序），
本机通过 HTTP 协议调用，提供 5 个模型工具 + 1 个 GUI 设置页。

版本：**1.2.0**（多服务器 + 全局配置 + GUI 设置页 + 二进制上传/下载）。
许可：MIT。

---

## 功能一览

| 工具 | 用途 |
|---|---|
| `remote_bash` | 持久 bash 会话（cwd/变量/后台任务跨调用保持，按 服务器×会话 隔离） |
| `remote_exec` | 一次性执行命令（无状态） |
| `remote_upload` | 本地上传文件到服务器（文本 + 二进制，单文件 ≤ 100 MiB） |
| `remote_download` | 从服务器下载文件到本地（文本 + 二进制，逐字节保留） |
| `remote_health` | 检查 Agent 连通性 |

所有工具支持可选 `server` 参数（服务器别名），缺省使用默认服务器。

---

## 快速开始

### 1. 在服务器上部署 Agent（一次性）

仓库 `agent/` 目录包含全部部署材料：

- `agent/agent.mjs` — 零依赖 Node HTTP 服务（协议见下文）
- `agent/agent.env.example` — 环境变量模板（复制为 `agent.env` 并生成真实令牌）
- `agent/dsh-agent.service` — systemd 单元（开机自启、崩溃自重启）

```bash
# ① 安装 Node.js（Alibaba Cloud Linux / CentOS）
yum install -y nodejs

# ② 创建专用用户（Agent 不以 root 运行）
useradd -r -m -s /usr/sbin/nologin dshagent

# ③ 部署程序并生成令牌
mkdir -p /opt/dsh-agent
# 将 agent.mjs 放到 /opt/dsh-agent/agent.mjs
TOKEN=$(openssl rand -hex 24)
printf 'DSH_AGENT_TOKEN=%s\nDSH_AGENT_PORT=28431\nDSH_AGENT_HOST=0.0.0.0\n' "$TOKEN" > /opt/dsh-agent/agent.env
chmod 600 /opt/dsh-agent/agent.env
chmod 755 /opt/dsh-agent/agent.mjs

# ④ 注册 systemd 服务
cat > /etc/systemd/system/dsh-agent.service <<'EOF'
[Unit]
Description=DSH remote agent
After=network.target

[Service]
Type=simple
User=dshagent
Group=dshagent
WorkingDirectory=/opt/dsh-agent
ExecStart=/usr/bin/node /opt/dsh-agent/agent.mjs
Restart=always
RestartSec=3
EnvironmentFile=/opt/dsh-agent/agent.env

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now dsh-agent

# ⑤ 放行端口（云控制台安全组 + 服务器本机防火墙）
# 入方向 TCP 28431（建议来源限你的公网 IP）
firewall-cmd --permanent --add-port=28431/tcp && firewall-cmd --reload   # firewalld
ufw allow 28431/tcp                                                       # ufw

# ⑥ 服务器本地验证
curl http://127.0.0.1:28431/health   # 返回 {"ok":true,...} 即成功
```

### 2. 在本机添加服务器

- **GUI**：设置 → "远程连接" → "+ 新增服务器"，填别名/地址/端口/令牌，保存后"测试连接"。
- **配置文件**：编辑 `~/.dsh/remote-servers.json`（DSH 全局层，任何工作区/会话共享）：

```json
{
  "version": 2,
  "default": "aliyun-main",
  "servers": [
    { "name": "aliyun-main", "host": "8.163.12.206", "port": 28431, "token": "…" }
  ]
}
```

### 3. 使用

```jsonc
// 模型工具示例
remote_health                       // 缺省服务器
remote_bash { "command": "df -h", "server": "aliyun-main" }
remote_exec  { "command": "uptime" }
remote_upload  { "local_path": "C:\\repo\\script.sh", "remote_path": "/opt/app/script.sh" }
remote_download{ "remote_path": "/var/log/app.log", "local_path": "./app.log" }
```

---

## 仓库结构

```
dsh-remote/
├── package.json        # 包声明：main = 宿主入口；exports["./client"] = 浏览器 bundle
├── lib/
│   ├── index.js        # 宿主插件：remote_* 工具 + /remote-agent/api GUI RPC
│   └── client.js       # 浏览器端 bundle（设置页 "远程连接"）
├── agent/
│   ├── agent.mjs       # 服务器端常驻 Agent（零依赖 node:http）
│   ├── agent.env.example
│   └── dsh-agent.service
├── docs/
│   └── TECHNICAL.md    # 技术文档：架构、协议、维护与扩展
└── README.md           # 本文件
```

---

## 相关文件（运行时机器的实际位置）

| 路径 | 说明 |
|---|---|
| `$DSH_HOME/remote-servers.json` | 权威配置（v2 多服务器）；GUI 保存统一写入此处 |
| profile 的 `cordis.patch.yml` | 组合接线：`- id: remote-tools / name: 'dsh-remote'` |

> 详细架构、Agent 协议、故障排查与扩展思路见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 许可证

MIT License — 见 [LICENSE](LICENSE)。
