import http from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * dsh-remote — remote control tools for the dsh remote agent (multi-server).
 *
 * Talks to the agent HTTP protocol implemented by `remote-agent/agent.mjs`:
 *   GET  /health, POST /exec, POST /shell (+ /shell/input, /shell/kill),
 *   GET  /download, POST /upload
 *
 * Connection settings live in `remote-servers.json` (v2, multi-server with
 * aliases) — the authoritative copy is `$DSH_HOME/remote-servers.json` so
 * every workspace/session shares it. Lookup order:
 *   DSH_REMOTE_CONFIG → $DSH_HOME/remote-servers.json → cwd/remote-servers.json
 *   → sessionCwd/remote-servers.json → legacy single-server remote-agent.json
 * Format:
 *   { "version": 2, "default": "aliyun-main",
 *     "servers": [ { "name": "aliyun-main", "host": "…", "port": 28431, "token": "…" } ] }
 *
 * Every remote_* tool accepts an optional `server` alias argument (defaults
 * to the configured default server). The settings UI (client half,
 * `settings.section` → 远程连接) manages the entries through `/remote-agent/api`.
 *
 * `remote_bash` keeps one persistent shell session per (agent, server); the
 * command wrapper protocol (stderr markers, `>&2`, trailing external flush)
 * is identical to dsh-winfix, so state (cwd, exports, background jobs)
 * persists across calls.
 */

export const name = 'remote'
export const inject = ['timer', 'tools', 'fs', 'webServer', 'settings']

const MAX_OUTPUT_CHARS = 16000
const TRUNCATED = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const SHELL_RESET = 'The remote shell session was reset; the next call reconnects with a fresh shell.'
const BASH_TIMEOUT_MS = 300000
const DRAIN_MS = 300
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export function apply(ctx) {
  const timer = ctx.timer
  const fsSvc = ctx.fs
  const webServer = ctx.webServer
  const settings = ctx.settings

  // ── multi-server config ───────────────────────────────────────────
  function configFileCandidates(exec) {
    const out = []
    if (process.env.DSH_REMOTE_CONFIG) out.push(process.env.DSH_REMOTE_CONFIG)
    if (process.env.DSH_HOME) out.push(join(process.env.DSH_HOME, 'remote-servers.json'))
    out.push(join(process.cwd(), 'remote-servers.json'))
    const sessionCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0) out.push(join(sessionCwd, 'remote-servers.json'))
    if (process.env.DSH_HOME) out.push(join(process.env.DSH_HOME, 'remote-agent.json'))
    out.push(join(process.cwd(), 'remote-agent.json'))
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0) out.push(join(sessionCwd, 'remote-agent.json'))
    return out
  }
  function normalizeEntry(input) {
    if (!input || typeof input !== 'object') throw new Error('invalid server entry')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!NAME_RE.test(name)) throw new Error('服务器别名必须匹配 [A-Za-z0-9_-]{1,32}，例如 aliyun-main')
    const host = typeof input.host === 'string' ? input.host.trim() : ''
    if (!host) throw new Error('服务器地址不能为空')
    const port = Number(input.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('端口必须是 1-65535 的整数')
    return { name, host, port, token: typeof input.token === 'string' ? input.token : '' }
  }
  function parseServersFile(file) {
    if (!existsSync(file)) return undefined
    let parsed
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    if (Array.isArray(parsed.servers)) {
      const list = []
      for (const item of parsed.servers) {
        try { list.push(normalizeEntry(item)) } catch { /* skip invalid entry */ }
      }
      if (list.length === 0) return undefined
      const defaultName = typeof parsed.default === 'string' && list.some((s) => s.name === parsed.default)
        ? parsed.default
        : list[0].name
      return { list, defaultName, file }
    }
    if (typeof parsed.host === 'string' && parsed.host) {
      // legacy single-server object → one entry named 'default'
      try {
        const entry = normalizeEntry({ name: 'default', host: parsed.host, port: parsed.port, token: parsed.token })
        return { list: [entry], defaultName: 'default', file, legacy: true }
      } catch { return undefined }
    }
    return undefined
  }
  function readServers(exec) {
    for (const file of configFileCandidates(exec)) {
      const result = parseServersFile(file)
      if (result) return result
    }
    return { list: [], defaultName: undefined, file: undefined }
  }
  function resolveServer(servers, name) {
    let target = name
    if (target === undefined || target === null || target === '') target = servers.defaultName
    if (target === undefined || target === '') {
      if (servers.list.length === 0) {
        throw new Error('remote: 未配置任何服务器。请在 设置 → 远程连接 中添加，或配置 remote-servers.json。')
      }
      target = servers.list[0].name
    }
    const found = servers.list.find((s) => s.name === target)
    if (!found) {
      throw new Error('remote: 未知服务器 "' + target + '"；可用别名: ' + (servers.list.map((s) => s.name).join(', ') || '(无)'))
    }
    return found
  }

  // ── HTTP helpers ──────────────────────────────────────────────────
  function apiRequest(cfg, method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: cfg.host,
        port: cfg.port,
        path,
        method,
        timeout: timeoutMs || 60000,
        headers: {
          authorization: 'Bearer ' + cfg.token,
          ...(typeof body === 'string' ? { 'content-type': 'text/plain' } : Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : {}),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        },
      }, (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            buffer: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => {
        req.destroy(new Error('request timed out after ' + (timeoutMs || 60000) + 'ms'))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  function describeError(error) {
    return error && error.message ? error.message : String(error)
  }

  // ── local binary write ────────────────────────────────────────────
  // The fs service only writes UTF-8 text, so downloads of binary files
  // (images, archives) need a raw byte write. Mirror the fs-sandbox fence
  // here: read-only denies, workspace-write restricts to the workspace/temp
  // roots, danger-full-access is unfenced.
  function sandboxPolicyFor(exec) {
    let policy
    try {
      const svc = ctx.get('sandboxPolicy')
      policy = svc === undefined ? undefined : svc.resolve(exec && exec.agent ? { session: exec.agent.session } : {})
    } catch (e) { policy = undefined }
    return policy
  }
  function pathUnder(root, p) {
    const a = resolvePath(root).toLowerCase()
    const b = resolvePath(p).toLowerCase()
    return b === a || b.startsWith(a + sep)
  }
  function assertWritableTarget(target, exec) {
    const policy = sandboxPolicyFor(exec)
    const mode = policy && policy.mode ? policy.mode : 'danger-full-access'
    if (mode === 'read-only') throw new Error('remote_download: write denied under read-only sandbox mode')
    if (mode !== 'workspace-write') return
    const p = fsSvc.processPath(target)
    const roots = [
      policy && typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : '',
      tmpdir(),
      ...(process.platform === 'win32' ? [] : ['/tmp']),
    ].filter((r) => typeof r === 'string' && r.length > 0)
    const ok = roots.some((root) => pathUnder(root, p))
    if (!ok) throw new Error('remote_download: write denied outside the workspace/temp roots under workspace-write sandbox mode')
  }
  async function writeBinaryLocal(target, bytes, exec) {
    assertWritableTarget(target, exec)
    writeFileSync(fsSvc.processPath(target), bytes)
  }

  // ── persistent remote shell (per agent, per server) ───────────────
  const sessions = new Map() // serverName -> Map(owner Agent -> state)

  function shellState(owner, serverName) {
    let byOwner = sessions.get(serverName)
    if (byOwner === undefined) {
      byOwner = new Map()
      sessions.set(serverName, byOwner)
    }
    let st = byOwner.get(owner)
    if (st === undefined) {
      st = {
        owner,
        serverName,
        cfg: undefined,
        sid: undefined,
        buffer: '',
        pending: undefined,
        dead: false,
        queue: Promise.resolve(),
      }
      byOwner.set(owner, st)
      if (owner && owner.ctx && typeof owner.ctx.effect === 'function') {
        try {
          owner.ctx.effect(() => () => {
            byOwner.delete(owner)
            if (st.sid !== undefined && st.cfg) {
              try {
                apiRequest(st.cfg, 'POST', '/shell/kill?id=' + encodeURIComponent(st.sid), undefined, 10000)
              } catch { /* best-effort */ }
            }
          }, 'dsh-remote shell owner cleanup')
        } catch (e) { /* best-effort */ }
      }
    }
    return st
  }

  function appendBuffer(st, text) {
    st.buffer = (st.buffer + text).slice(-(2 * 1024 * 1024))
    const p = st.pending
    if (p !== undefined) {
      const idx = st.buffer.lastIndexOf(p.endM)
      if (idx >= 0) {
        const m = /^(\d+)\r?\n/.exec(st.buffer.slice(idx + p.endM.length))
        if (m) {
          st.pending = undefined
          p.resolve({ status: Number(m[1]) })
        }
      }
    }
  }

  async function ensureSession(st, exec, signal) {
    if (!st.dead && st.sid !== undefined) return
    const servers = readServers(exec)
    const cfg = resolveServer(servers, st.serverName)
    st.cfg = cfg
    st.dead = false
    st.buffer = ''
    const sid = await new Promise((resolve, reject) => {
      const req = http.request({
        host: cfg.host,
        port: cfg.port,
        path: '/shell',
        method: 'POST',
        timeout: 30000,
        headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
      }, (res) => {
        const sessionId = res.headers['x-session']
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          res.resume()
          reject(new Error('remote: shell create failed (HTTP ' + res.statusCode + ')'))
          return
        }
        resolve(sessionId)
        res.on('data', (d) => appendBuffer(st, d.toString('utf8')))
        res.on('end', () => { st.dead = true })
        res.on('error', () => { st.dead = true })
      })
      req.on('timeout', () => req.destroy(new Error('remote: shell create timed out')))
      req.on('error', reject)
      req.end('{}')
    })
    st.sid = sid
  }

  function quoteForBash(value) {
    return "$'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n') + "'"
  }

  function wrapCommand(command, start, end) {
    return "printf '%s\\n' " + quoteForBash(start) + " >&2; eval -- " + quoteForBash(command) + " >&2; __dsh_status=$?; printf '%s%s\\n' " + quoteForBash(end) + ' "$__dsh_status" >&2; /usr/bin/sleep 0 >/dev/null 2>&1'
  }

  function nonce() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }

  function sanitizeTerminal(text) {
    return text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b[()][0-9A-Za-z]/g, '')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
  }

  function stripPrompt(text) {
    let result = sanitizeTerminal(text)
    while (result.endsWith('\n')) result = result.slice(0, -1)
    return result.replace(/^\n+/, '')
  }

  function maybeTruncate(content) {
    return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED
  }

  async function resetSession(st) {
    if (st.sid !== undefined && st.cfg) {
      try {
        await apiRequest(st.cfg, 'POST', '/shell/kill?id=' + encodeURIComponent(st.sid), undefined, 15000)
      } catch { /* best-effort */ }
    }
    st.sid = undefined
    st.dead = true
    st.buffer = ''
    st.pending = undefined
  }

  function extractPartial(st, startM) {
    const idx = st.buffer.lastIndexOf(startM)
    const text = idx >= 0 ? st.buffer.slice(idx + startM.length) : st.buffer
    return maybeTruncate(stripPrompt(text))
  }

  async function runRemoteBash(st, command, exec) {
    const signal = exec.signal
    await ensureSession(st, exec, signal)
    const n = nonce()
    const startM = '__DSH_REMOTE_START_' + n + '__'
    const endM = '__DSH_REMOTE_END_' + n + ':'
    const wrapped = wrapCommand(command, startM, endM)

    let doneResolve
    const done = new Promise((res) => { doneResolve = res })
    st.pending = { startM, endM, resolve: doneResolve }

    let abortReject
    const abortP = new Promise((_, rej) => { abortReject = rej })
    const onAbort = () => abortReject(new Error('remote_bash call aborted'))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutP = timer.timeout(BASH_TIMEOUT_MS).then(() => ({ kind: 'timeout' }))

    try {
      let input = await apiRequest(st.cfg, 'POST', '/shell/input?id=' + encodeURIComponent(st.sid), wrapped + '\n', 30000)
      if (input.status === 404 || input.status === 410) {
        await resetSession(st)
        await ensureSession(st, exec, signal)
        st.pending = { startM, endM, resolve: doneResolve }
        input = await apiRequest(st.cfg, 'POST', '/shell/input?id=' + encodeURIComponent(st.sid), wrapped + '\n', 30000)
      }
      if (input.status !== 200) {
        await resetSession(st)
        throw new Error('remote: shell input failed (HTTP ' + input.status + '): ' + input.body.slice(0, 300))
      }
      const winner = await Promise.race([done, timeoutP, abortP])
      if (signal && signal.aborted) {
        await resetSession(st)
        throw new Error('remote_bash call aborted')
      }
      if (winner && winner.kind === 'timeout') {
        const partial = extractPartial(st, startM)
        await resetSession(st)
        return ['Your remote command timed out after ' + Math.round(BASH_TIMEOUT_MS / 1000) + ' seconds. Below is partial output:', partial, SHELL_RESET].join('\n')
      }
      await timer.timeout(DRAIN_MS)
      const endIdx = st.buffer.lastIndexOf(endM)
      const startIdx = st.buffer.lastIndexOf(startM, endIdx < 0 ? undefined : endIdx)
      const raw = st.buffer.slice(startIdx >= 0 ? startIdx + startM.length : 0, endIdx < 0 ? undefined : endIdx)
      const text = maybeTruncate(stripPrompt(raw))
      const status = winner.status
      return status === 0 ? text : (text.length === 0 ? '[exit code: ' + status + ']' : text + '\n[exit code: ' + status + ']')
    } finally {
      st.pending = undefined
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  // ── tools ─────────────────────────────────────────────────────────
  function serverParam() {
    return {
      type: 'string',
      description: '远程服务器别名（在 设置 → 远程连接 中配置）。缺省使用默认服务器。',
    }
  }
  function resolveForExec(exec, name) {
    const servers = readServers(exec)
    return resolveServer(servers, name)
  }

  const bashTool = defineTool({
    name: 'remote_bash',
    description: [
      'Run a command in a persistent bash shell ON THE REMOTE SERVER. State, including the current directory and exported environment variables, persists across calls (per server).',
      '* The remote agent runs as a dedicated non-root user (dshagent) on the server.',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      '* Please avoid commands that may produce a very large amount of output.',
      '* Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
      '* Servers are configured in 设置 → 远程连接 (remote-servers.json).'
    ].join('\n'),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run on the remote server.' },
      server: serverParam(),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const owner = exec.agent
      if (owner === undefined) throw new Error('remote_bash requires an owning agent session')
      const servers = readServers(exec)
      const cfg = resolveServer(servers, args.server)
      const st = shellState(owner, cfg.name)
      const run = st.queue.then(() => runRemoteBash(st, args.command, exec), () => runRemoteBash(st, args.command, exec))
      st.queue = run.then(() => undefined, () => undefined)
      return run
    },
    presentCall: (args) => ({ card: 'terminal', title: (args.server ? args.server + ': ' : '') + args.command })
  })

  const execTool = defineTool({
    name: 'remote_exec',
    description: [
      'Run one command on the remote server in a fresh shell and return its output. Unlike remote_bash, no state persists between calls.',
      '* The remote agent runs as a dedicated non-root user (dshagent) on the server.',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      '* Servers are configured in 设置 → 远程连接 (remote-servers.json).'
    ].join('\n'),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run on the remote server.' },
      server: serverParam(),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const cfg = resolveForExec(exec, args.server)
      const result = await apiRequest(cfg, 'POST', '/exec', JSON.stringify({ cmd: args.command }), 120000)
      if (result.status !== 200) throw new Error('remote: exec failed (HTTP ' + result.status + '): ' + result.body.slice(0, 300))
      return result.body
    },
    presentCall: (args) => ({ card: 'terminal', title: (args.server ? args.server + ': ' : '') + args.command })
  })

  const uploadTool = defineTool({
    name: 'remote_upload',
    description: [
      'Upload a local file to the remote server.',
      '* local_path: a local file path (Windows style like C:\\\\repo\\\\script.sh, POSIX style like /repo/script.sh resolves under the local session workspace, or relative).',
      '* remote_path: an absolute path on the server (e.g. /home/dshagent/script.sh or /opt/app/script.sh).',
      '* Binary files (images, archives, executables) are supported; the size limit is 100 MiB.',
      '* Returns the server-side path on success.'
    ].join('\n'),
    parameters: {
      local_path: { type: 'string', required: true, description: 'Local file path to upload.' },
      remote_path: { type: 'string', required: true, description: 'Absolute destination path on the server.' },
      server: serverParam(),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      if (typeof args.local_path !== 'string' || args.local_path.length === 0) throw new Error('local_path must be a non-empty string')
      if (typeof args.remote_path !== 'string' || args.remote_path.length === 0) throw new Error('remote_path must be a non-empty string')
      const cfg = resolveForExec(exec, args.server)
      const cwd = (exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || process.cwd()
      let local = args.local_path.trim()
      if (!/^[A-Za-z]:[\\/]/.test(local) && !local.startsWith('\\\\') && local.startsWith('/')) {
        local = join(cwd, local.replace(/^\/+/, ''))
      } else if (!/^[A-Za-z]:[\\/]/.test(local) && !local.startsWith('\\\\')) {
        local = join(cwd, local)
      }
      let target
      try {
        target = await fsSvc.resolve(local, { cwd, signal: exec.signal })
      } catch (e) {
        throw new Error('remote_upload: cannot resolve local path: ' + (e && e.message ? e.message : String(e)))
      }
      const info = await fsSvc.stat(target, exec.signal)
      if (info === undefined || info.type !== 'file') throw new Error('remote_upload: local file not found: ' + local)
      if (info.size !== undefined && info.size > 100 * 1024 * 1024) throw new Error('remote_upload: file too large (limit 100 MiB): ' + local)
      // raw bytes: text AND binary (images, archives) — the agent streams the
      // body straight to disk, so nothing is decoded or re-encoded
      const bytes = Buffer.from(await fsSvc.readBytes(target, exec.signal, 100 * 1024 * 1024))
      const result = await apiRequest(cfg, 'POST', '/upload?path=' + encodeURIComponent(args.remote_path.trim()), bytes, 120000)
      if (result.status !== 200) throw new Error('remote: upload failed (HTTP ' + result.status + '): ' + result.body.slice(0, 300))
      return 'Uploaded ' + local + ' -> ' + cfg.name + ':' + args.remote_path.trim() + ' (' + bytes.length + ' bytes)'
    },
    presentCall: (args) => ({ card: 'generic', title: 'upload ' + args.local_path, kind: 'edit' })
  })

  const downloadTool = defineTool({
    name: 'remote_download',
    description: [
      'Download a remote file from the server to a local path.',
      '* remote_path: an absolute path on the server (e.g. /var/log/app.log).',
      '* local_path: the local destination file path (Windows or POSIX style; resolves under the local session workspace).',
      '* Files are downloaded as raw bytes — both text and binary (images, archives) are preserved byte-for-byte.'
    ].join('\n'),
    parameters: {
      remote_path: { type: 'string', required: true, description: 'Absolute source path on the server.' },
      local_path: { type: 'string', required: true, description: 'Local destination file path.' },
      server: serverParam(),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      if (typeof args.remote_path !== 'string' || args.remote_path.length === 0) throw new Error('remote_path must be a non-empty string')
      if (typeof args.local_path !== 'string' || args.local_path.length === 0) throw new Error('local_path must be a non-empty string')
      const cfg = resolveForExec(exec, args.server)
      const result = await apiRequest(cfg, 'GET', '/download?path=' + encodeURIComponent(args.remote_path.trim()), undefined, 120000)
      if (result.status !== 200) throw new Error('remote: download failed (HTTP ' + result.status + '): ' + result.body.slice(0, 300))
      const cwd = (exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || process.cwd()
      let local = args.local_path.trim()
      if (!/^[A-Za-z]:[\\/]/.test(local) && !local.startsWith('\\\\') && local.startsWith('/')) {
        local = join(cwd, local.replace(/^\/+/, ''))
      } else if (!/^[A-Za-z]:[\\/]/.test(local) && !local.startsWith('\\\\')) {
        local = join(cwd, local)
      }
      let target
      try {
        target = await fsSvc.resolve(local, { cwd, signal: exec.signal })
      } catch (e) {
        throw new Error('remote_download: cannot resolve local path: ' + (e && e.message ? e.message : String(e)))
      }
      // raw-byte write (text AND binary); the fs service has no binary write,
      // so the sandbox fence is mirrored here (see writeBinaryLocal)
      await writeBinaryLocal(target, result.buffer, exec)
      return 'Downloaded ' + cfg.name + ':' + args.remote_path.trim() + ' -> ' + local + ' (' + result.buffer.length + ' bytes)'
    },
    presentCall: (args) => ({ card: 'generic', title: 'download ' + args.remote_path, kind: 'read' })
  })

  const healthTool = defineTool({
    name: 'remote_health',
    description: 'Check whether a remote agent is reachable and healthy.',
    parameters: {
      server: serverParam(),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const servers = readServers(exec)
      const cfg = resolveServer(servers, args.server)
      try {
        const result = await apiRequest(cfg, 'GET', '/health', undefined, 15000)
        if (result.status === 200) return 'remote agent OK (' + cfg.name + ' @ ' + cfg.host + ':' + cfg.port + '): ' + result.body
        return 'remote agent (' + cfg.name + ') responded HTTP ' + result.status + ': ' + result.body.slice(0, 200)
      } catch (e) {
        return 'remote agent (' + cfg.name + ' @ ' + cfg.host + ':' + cfg.port + ') unreachable: ' + describeError(e)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'remote_health', kind: 'read' })
  })

  ctx.tools.register(bashTool)
  ctx.tools.register(execTool)
  ctx.tools.register(uploadTool)
  ctx.tools.register(downloadTool)
  ctx.tools.register(healthTool)

  // ── settings GUI API ──────────────────────────────────────────────
  async function guiDshHome() {
    try {
      const doc = await settings.prepareDocument()
      if (doc && typeof doc === 'string') {
        const idx = Math.max(doc.lastIndexOf('/'), doc.lastIndexOf('\\'))
        if (idx > 0) return doc.slice(0, idx)
      }
    } catch (e) { /* fall through */ }
    return process.env.DSH_HOME || undefined
  }
  async function guiWriteFile(payload) {
    const home = await guiDshHome()
    const targets = []
    if (home) targets.push(join(home, 'remote-servers.json'))
    targets.push(join(process.cwd(), 'remote-servers.json'))
    let savedPath = null
    for (const file of targets) {
      try {
        writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
        savedPath = file
      } catch (e) {
        console.error('[dsh-remote] save to', file, 'failed:', e && e.message)
      }
    }
    if (!savedPath) throw new Error('无法写入配置文件')
    return savedPath
  }
  async function guiSave(input) {
    const entry = normalizeEntry(input && input.entry)
    const current = readServers(undefined)
    const list = current.list.filter((s) => s.name !== entry.name)
    list.push(entry)
    let defaultName = current.defaultName
    if (defaultName === undefined || defaultName === '' || input.setDefault === true) defaultName = entry.name
    const payload = { version: 2, default: defaultName, servers: list }
    const path = await guiWriteFile(payload)
    return { path, default: defaultName, name: entry.name }
  }
  async function guiRemove(input) {
    const name = input && typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new Error('缺少服务器别名')
    const current = readServers(undefined)
    const list = current.list.filter((s) => s.name !== name)
    if (list.length === current.list.length) throw new Error('未找到服务器 "' + name + '"')
    const defaultName = current.defaultName === name ? (list[0] ? list[0].name : undefined) : current.defaultName
    const payload = { version: 2, default: defaultName, servers: list }
    const path = await guiWriteFile(payload)
    return { removed: true, default: defaultName, path }
  }
  async function guiTest(input) {
    let cfg
    if (input && input.name) {
      const servers = readServers(undefined)
      cfg = resolveServer(servers, input.name)
    } else if (input && input.entry) {
      cfg = normalizeEntry(input.entry)
    } else {
      throw new Error('请提供服务器别名或连接参数')
    }
    try {
      const result = await apiRequest(cfg, 'GET', '/health', undefined, 15000)
      if (result.status === 200) {
        let detail = 'agent 正常运行'
        try {
          const j = JSON.parse(result.body)
          if (j && j.ok) detail = 'agent 正常运行（uptime ' + (j.uptime !== undefined ? j.uptime + 's' : '?') + '）'
        } catch (e) { /* keep default */ }
        return { healthy: true, status: result.status, detail, name: cfg.name, host: cfg.host, port: cfg.port }
      }
      return { healthy: false, status: result.status, detail: result.body.slice(0, 300), name: cfg.name, host: cfg.host, port: cfg.port }
    } catch (e) {
      return { healthy: false, status: null, detail: (e && e.message) || String(e), name: cfg.name, host: cfg.host, port: cfg.port }
    }
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 262144) { reject(new Error('request too large')); req.destroy(); return; }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/remote-agent/api',
      handler: async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        try {
          const body = await readBody(req)
          let args = {}
          try { args = JSON.parse(body || '{}') } catch (e) { args = {} }
          const op = args && args.op
          let result
          switch (op) {
            case 'list': {
              const servers = readServers(undefined)
              result = { default: servers.defaultName || null, servers: servers.list, source: servers.file || null }
              break
            }
            case 'save': result = await guiSave(args); break
            case 'remove': result = await guiRemove(args); break
            case 'test': result = await guiTest(args); break
            default: throw new Error('unknown op: ' + String(op))
          }
          res.writeHead(200)
          res.end(JSON.stringify(Object.assign({ ok: true }, result)))
        } catch (e) {
          res.writeHead(200)
          res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }))
        }
      },
    }), 'dsh-remote: api route')
  }

  // Plugin-stop cleanup: kill every live remote shell session.
  ctx.effect(() => async () => {
    const closing = []
    for (const byOwner of sessions.values()) {
      for (const st of byOwner.values()) {
        if (st.sid !== undefined && st.cfg) {
          closing.push(apiRequest(st.cfg, 'POST', '/shell/kill?id=' + encodeURIComponent(st.sid), undefined, 10000).catch(() => undefined))
        }
      }
    }
    await Promise.allSettled(closing)
    sessions.clear()
  }, 'dsh-remote session cleanup')
}
