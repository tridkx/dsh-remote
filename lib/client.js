window.__ModuleLoader__.load({
	id: "dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// ── styles ────────────────────────────────────────────────────────────
		const CSS = `
.rag-page{display:flex;flex-direction:column;gap:10px;padding:2px 0 12px;min-width:0;max-width:760px}
.rag-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.rag-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;line-height:18px}
.rag-notice{padding:6px 10px;border-radius:8px;font-size:12px;line-height:18px;border:1px solid;word-break:break-all}
.rag-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.rag-notice[data-kind=ok]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.rag-notice[data-kind=info]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.rag-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.rag-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rag-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace}
.rag-meta{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace;word-break:break-all;min-width:0}
.rag-badge[data-on=true]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.rag-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 5px;line-height:16px}
.rag-btn{font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;line-height:18px}
.rag-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.rag-btn[data-primary]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rag-btn[data-danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.rag-btn:disabled{opacity:.5;cursor:default}
.rag-form{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1)}
.rag-field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rag-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;font-family:ui-monospace,Consolas,monospace;box-sizing:border-box;width:100%}
.rag-input:focus{outline:1px solid var(--dsw-alias-brand-primary)}
.rag-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 0}
.rag-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:16px}
.rag-guide{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:20px;max-width:760px}
.rag-guide h4{margin:10px 0 4px;font-size:12px;color:var(--dsw-alias-label-primary)}
.rag-guide pre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);overflow:auto;font-family:ui-monospace,Consolas,monospace;margin:4px 0}
.rag-guide p{margin:4px 0}`;

		// ── server deployment guide ───────────────────────────────────────────
		const GUIDE_HTML = '<div>' +
			'<p>每台新服务器需要一次性部署 dsh 远程 Agent（零依赖 Node 程序），步骤如下：</p>' +
			'<h4>① 准备 Node.js</h4>' +
			'<pre># Alibaba Cloud Linux / CentOS\nyum install -y nodejs\n# Ubuntu / Debian\napt update && apt install -y nodejs</pre>' +
			'<h4>② 创建专用用户（Agent 不以 root 运行）</h4>' +
			'<pre>useradd -r -m -s /usr/sbin/nologin dshagent</pre>' +
			'<h4>③ 部署 Agent 程序并生成令牌</h4>' +
			'<pre>mkdir -p /opt/dsh-agent\n# 将 agent.mjs 放到 /opt/dsh-agent/agent.mjs（本机留档：D:\\dsh-default\\remote-agent\\agent.mjs）\n\nTOKEN=$(openssl rand -hex 24)\nprintf \'DSH_AGENT_TOKEN=%s\\nDSH_AGENT_PORT=28431\\nDSH_AGENT_HOST=0.0.0.0\\n\' "$TOKEN" &gt; /opt/dsh-agent/agent.env\nchmod 600 /opt/dsh-agent/agent.env\nchmod 755 /opt/dsh-agent/agent.mjs</pre>' +
			'<h4>④ 注册 systemd 服务（开机自启、崩溃自重启）</h4>' +
			'<pre>cat &gt; /etc/systemd/system/dsh-agent.service &lt;&lt;\'EOF\'\n[Unit]\nDescription=DSH remote agent\nAfter=network.target\n\n[Service]\nType=simple\nUser=dshagent\nGroup=dshagent\nWorkingDirectory=/opt/dsh-agent\nExecStart=/usr/bin/node /opt/dsh-agent/agent.mjs\nRestart=always\nRestartSec=3\nEnvironmentFile=/opt/dsh-agent/agent.env\n\n[Install]\nWantedBy=multi-user.target\nEOF\nsystemctl daemon-reload &amp;&amp; systemctl enable --now dsh-agent</pre>' +
			'<h4>⑤ 放行端口（云控制台安全组 + 服务器本机防火墙）</h4>' +
			'<pre># 云控制台安全组：入方向 TCP 28431（建议来源限你的公网 IP）\n# 服务器本机防火墙（如果开启）：\nfirewall-cmd --permanent --add-port=28431/tcp &amp;&amp; firewall-cmd --reload   # firewalld\nufw allow 28431/tcp                                                       # ufw</pre>' +
			'<h4>⑥ 服务器本地验证</h4>' +
			'<pre>curl http://127.0.0.1:28431/health   # 返回 {"ok":true,...} 即成功</pre>' +
			'<h4>⑦ 回到本页</h4>' +
			'<p>「+ 新增服务器」→ 填写别名 / 地址 / 端口 / 第③步生成的 TOKEN → 保存 → 测试连接。之后 remote_bash / remote_exec 等工具即可通过 server 参数（别名）选择该服务器。</p>' +
			'</div>';

		// ── settings page ─────────────────────────────────────────────────────
		async function api(op, payload) {
			const res = await fetch('/remote-agent/api', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(Object.assign({ op }, payload || {})),
			});
			return res.json();
		}

		function RemoteAgentPage() {
			const [state, setState] = React.useState({ status: 'loading' });
			const [notice, setNotice] = React.useState(null);
			const [busy, setBusy] = React.useState({});
			const [editing, setEditing] = React.useState(null);
			const [confirmRemove, setConfirmRemove] = React.useState(null);

			const refresh = async () => {
				try {
					const res = await api('list');
					if (!res || !res.ok) { setState({ status: 'error', error: (res && res.error) || 'list failed' }); return; }
					setState({ status: 'ready', default: res.default, servers: res.servers || [], source: res.source || null });
					setNotice(null);
				} catch (e) {
					setState({ status: 'error', error: 'RPC failed: ' + String((e && e.message) || e) });
				}
			};
			React.useEffect(() => { refresh(); }, []);

			const act = async (op, payload, key) => {
				setBusy((b) => Object.assign({}, b, { [key]: true }));
				try {
					const res = await api(op, payload);
					if (!res || !res.ok) setNotice({ kind: 'error', text: (res && res.error) || '操作失败' });
					return res;
				} catch (e) {
					setNotice({ kind: 'error', text: String((e && e.message) || e) });
					return null;
				} finally {
					setBusy((b) => { const n = Object.assign({}, b); delete n[key]; return n; });
				}
			};

			const findEntry = (name) => {
				const s = (state.status === 'ready' ? state.servers : []).find((x) => x.name === name);
				return s ? { name: s.name, host: s.host, port: s.port, token: s.token || '' } : null;
			};
			const doTest = async (name) => {
				const res = await act('test', { name }, 'test:' + name);
				if (!res || !res.ok) return;
				if (res.healthy) setNotice({ kind: 'ok', text: '[' + name + '] ' + (res.detail || '连接成功') });
				else setNotice({ kind: 'error', text: '[' + name + '] ' + (res.detail || ('HTTP ' + res.status)) });
			};
			const doSetDefault = async (name) => {
				const entry = findEntry(name);
				if (!entry) return;
				const res = await act('save', { entry, setDefault: true }, 'default:' + name);
				if (res && res.ok) { setNotice({ kind: 'ok', text: '已将 [' + name + '] 设为默认服务器' }); await refresh(); }
			};
			const doRemove = async (name) => {
				const res = await act('remove', { name }, 'remove:' + name);
				if (res && res.ok) { setNotice({ kind: 'ok', text: '已删除 [' + name + ']' }); setConfirmRemove(null); await refresh(); }
			};

			const openNew = () => setEditing({ originalName: '', name: '', host: '', port: '28431', token: '', setDefault: false });
			const openEdit = (server) => setEditing({
				originalName: server.name,
				name: server.name,
				host: server.host,
				port: String(server.port || ''),
				token: server.token || '',
				setDefault: false,
			});
			const setForm = (patch) => setEditing((e) => (e ? Object.assign({}, e, patch) : e));
			const saveForm = async () => {
				if (!editing) return;
				const res = await act('save', {
					entry: { name: editing.name, host: editing.host, port: Number(editing.port) || 0, token: editing.token },
					setDefault: editing.setDefault,
				}, 'save');
				if (res && res.ok) {
					setNotice({ kind: 'ok', text: '已保存 [' + editing.name + ']（全局生效）' + (editing.setDefault ? '，并设为默认' : '') });
					setEditing(null);
					await refresh();
				}
			};

			const ready = state.status === 'ready';
			const servers = ready ? state.servers : [];
			const [showGuide, setShowGuide] = React.useState(false);

			return h('div', { className: 'rag-page' },
				h('p', { className: 'rag-title' }, '远程连接'),
				h('p', { className: 'rag-sub' }, '配置 dsh 远程 Agent（服务器端常驻程序）。配置保存在 ~/.dsh/remote-servers.json，整个 dsh 全局共享；remote_bash / remote_exec / remote_upload / remote_download / remote_health 可用 server 参数按别名选择服务器。'),
				notice ? h('div', { className: 'rag-notice', 'data-kind': notice.kind }, notice.text) : null,
				state.status === 'loading' ? h('p', { className: 'rag-empty' }, '读取配置中…') : null,
				state.status === 'error' ? h('div', { className: 'rag-notice', 'data-kind': 'error' }, '读取配置失败: ' + state.error) : null,
				ready ? h('div', { className: 'rag-row' },
					h('button', { className: 'rag-btn', 'data-primary': true, onClick: openNew }, '+ 新增服务器'),
					h('button', { className: 'rag-btn', onClick: () => setShowGuide(!showGuide) }, showGuide ? '收起教程' : '怎么在服务器上配置'),
					state.source ? h('span', { className: 'rag-hint' }, '配置读取自: ' + state.source + '（保存统一写入 ~/.dsh/remote-servers.json）') : null,
				) : null,
				showGuide ? h('div', { className: 'rag-guide', dangerouslySetInnerHTML: { __html: GUIDE_HTML } }) : null,
				ready && servers.length === 0 ? h('div', { className: 'rag-empty' }, '还没有服务器。点击「+ 新增服务器」添加，例如别名 aliyun-main、地址 8.163.12.206、端口 28431。') : null,
				ready ? servers.map((server) => h('div', { className: 'rag-card', key: server.name },
					h('div', { className: 'rag-row' },
						h('span', { className: 'rag-name' }, server.name),
						server.name === state.default ? h('span', { className: 'rag-badge', 'data-on': 'true' }, '默认') : null,
						h('span', { className: 'rag-meta' }, server.host + ':' + server.port),
					),
					h('div', { className: 'rag-row' },
						h('button', { className: 'rag-btn', disabled: !!busy['test:' + server.name], onClick: () => doTest(server.name) }, '测试连接'),
						server.name !== state.default
							? h('button', { className: 'rag-btn', disabled: !!busy['default:' + server.name], onClick: () => doSetDefault(server.name) }, '设为默认')
							: null,
						h('button', { className: 'rag-btn', onClick: () => openEdit(server) }, '编辑'),
						confirmRemove === server.name
							? h('span', { className: 'rag-row' },
								h('button', { className: 'rag-btn', 'data-danger': true, disabled: !!busy['remove:' + server.name], onClick: () => doRemove(server.name) }, '确认删除'),
								h('button', { className: 'rag-btn', onClick: () => setConfirmRemove(null) }, '取消'))
							: h('button', { className: 'rag-btn', 'data-danger': true, onClick: () => setConfirmRemove(server.name) }, '删除'),
					),
				)) : null,
				editing ? h('form', { className: 'rag-form', onSubmit: (ev) => { ev.preventDefault(); saveForm(); } },
					h('p', { className: 'rag-title' }, editing.originalName ? '编辑服务器 ' + editing.originalName : '新增服务器'),
					h('label', { className: 'rag-field' }, '别名（[A-Za-z0-9_-]，最长 32，方便记忆与交流）',
						h('input', { className: 'rag-input', placeholder: 'aliyun-main', value: editing.name, onChange: (ev) => setForm({ name: ev.target.value }) })),
					h('label', { className: 'rag-field' }, '服务器地址（IP 或域名）',
						h('input', { className: 'rag-input', placeholder: '8.163.12.206', value: editing.host, onChange: (ev) => setForm({ host: ev.target.value }) })),
					h('label', { className: 'rag-field' }, '端口',
						h('input', { className: 'rag-input', placeholder: '28431', value: editing.port, onChange: (ev) => setForm({ port: ev.target.value }) })),
					h('label', { className: 'rag-field' }, '访问令牌（Token）',
						h('input', { className: 'rag-input', type: 'password', placeholder: '服务器 agent.env 中的 DSH_AGENT_TOKEN', value: editing.token, onChange: (ev) => setForm({ token: ev.target.value }) })),
					h('label', { className: 'rag-field' },
						h('span', null,
							h('input', { type: 'checkbox', checked: !!editing.setDefault, onChange: (ev) => setForm({ setDefault: ev.target.checked }) }),
							' 保存后设为默认服务器'),
					),
					h('div', { className: 'rag-row' },
						h('button', { className: 'rag-btn', 'data-primary': true, type: 'submit', disabled: !!busy.save }, '保存'),
						h('button', { className: 'rag-btn', type: 'button', onClick: () => setEditing(null) }, '取消'),
					),
				) : null,
			);
		}

		// ── apply ──────────────────────────────────────────────────────────────
		function apply(ctx) {
			if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-remote"]') === null) {
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-remote';
				tag.dataset.pluginCss = 'dsh-remote';
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			slots.inject('settings.section', () => slots.register(
				{ name: 'settings.section', id: 'remote-agent', order: 30, label: () => '远程连接' },
				(props) => h(RemoteAgentPage, props),
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
