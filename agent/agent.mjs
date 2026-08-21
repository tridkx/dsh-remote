// dsh remote agent — zero-dependency Node HTTP server for remote control.
//
// Protocol (all requests except /health require `Authorization: Bearer <token>`):
//   GET  /health                  -> {"ok":true,"version":1,"uptime":<s>}
//   POST /exec                   body {"cmd": string, "timeoutMs"?: number, "cwd"?: string}
//                                -> chunked text stream, ends with "\n[exit:<code>]\n"
//   POST /shell                  body {"cwd"?: string}
//                                -> 200, header `x-session: <id>`, chunked stream of the
//                                   shell's merged stdout+stderr until the session dies
//   POST /shell/input?id=<id>    body = raw bytes to write to that shell's stdin -> {"ok":true}
//   POST /shell/kill?id=<id>     -> kills the session's process tree -> {"ok":true}
//   GET  /download?path=<abs>    -> file bytes (text/octet-stream); 404/400 on error
//   POST /upload?path=<abs>      body = file bytes -> {"ok":true,"bytes":n}
//
// The persistent shell is a plain `bash --noprofile --norc -s` over pipes;
// the client drives it with the same stderr-marker wrapper protocol as
// dsh-winfix. Sessions die with the agent process.

import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import crypto from 'node:crypto'

const TOKEN = process.env.DSH_AGENT_TOKEN || ''
const PORT = Number(process.env.DSH_AGENT_PORT || 28431)
const HOST = process.env.DSH_AGENT_HOST || '0.0.0.0'
const SHELL_PATH = process.env.DSH_AGENT_SHELL || '/bin/bash'
const MAX_BODY = 1024 * 1024 * 1024 // 1 GiB upload cap

const sessions = new Map()

function auth(req) {
  if (!TOKEN) return true
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (typeof token !== 'string' || token.length !== TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function fail(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function newId() {
  return crypto.randomBytes(8).toString('hex')
}

function readBody(req, res, onDone) {
  const chunks = []
  let size = 0
  let settled = false
  req.on('data', (chunk) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_BODY) {
      settled = true
      fail(res, 413, 'body too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    onDone(Buffer.concat(chunks))
  })
  req.on('error', () => {
    if (!settled) {
      settled = true
      fail(res, 400, 'request error')
    }
  })
}

function handleExec(req, res, body) {
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return fail(res, 400, 'invalid JSON body')
  }
  const cmd = parsed.cmd
  if (typeof cmd !== 'string' || cmd.length === 0) return fail(res, 400, 'cmd must be a non-empty string')
  const timeoutMs = Number.isFinite(parsed.timeoutMs) ? parsed.timeoutMs : 0
  const cwd = typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : undefined
  let child
  try {
    child = spawn(SHELL_PATH, ['-c', cmd], {
      cwd,
      env: { ...process.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: '', DSH_REMOTE: '1' },
    })
  } catch (error) {
    return fail(res, 500, 'spawn failed: ' + error.message)
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'transfer-encoding': 'chunked', 'x-dsh-exec': '1' })
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        res.write('\n[remote exec timed out after ' + Math.round(timeoutMs / 1000) + 's]\n')
      }, timeoutMs)
    : null
  child.stdout.on('data', (d) => res.write(d))
  child.stderr.on('data', (d) => res.write(d))
  child.on('error', (error) => {
    if (timer) clearTimeout(timer)
    res.end('\n[spawn error: ' + error.message + ']\n')
  })
  child.on('close', (code, signal) => {
    if (timer) clearTimeout(timer)
    res.end('\n[exit:' + String(code) + (signal ? ':' + signal : '') + ']\n')
  })
}

function createShell(req, res, body) {
  let parsed = {}
  try { parsed = JSON.parse(body.toString('utf8')) } catch { /* defaults */ }
  const cwd = typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : undefined
  const id = newId()
  let child
  try {
    child = spawn(SHELL_PATH, ['--noprofile', '--norc', '-s'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', PS1: '', BASH_SILENCE_DEPRECATION_WARNING: '1', DSH_REMOTE: '1' },
    })
  } catch (error) {
    return fail(res, 500, 'spawn failed: ' + error.message)
  }
  const session = { id, child, subs: new Set([res]), closed: false }
  sessions.set(id, session)
  console.log('[shell] session', id, 'pid', child.pid)

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'transfer-encoding': 'chunked', 'x-session': id })
  // Node buffers response headers until the first write/end — flush them now
  // so the client learns the session id even before any shell output arrives.
  res.flushHeaders()
  console.log('[shell] headers sent for', id)
  const push = (chunk) => {
    for (const sub of session.subs) {
      try { sub.write(chunk) } catch { /* ignore */ }
    }
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  child.on('error', (error) => {
    console.log('[shell] session', id, 'error:', error.message)
    for (const sub of session.subs) {
      try { sub.end('\n[shell error: ' + error.message + ']\n') } catch { /* ignore */ }
    }
    session.subs.clear()
    if (!session.closed) {
      session.closed = true
      sessions.delete(id)
    }
  })
  child.on('close', (code) => {
    console.log('[shell] session', id, 'child closed code', code)
    for (const sub of session.subs) {
      try { sub.end('\n[shell exited: ' + String(code) + ']\n') } catch { /* ignore */ }
    }
    session.subs.clear()
    if (!session.closed) {
      session.closed = true
      sessions.delete(id)
    }
  })
  // Watch the RESPONSE socket, not the request: Node fires the request
  // 'close' event as soon as the request body is fully consumed, while the
  // response 'close' fires when the client connection actually goes away.
  res.on('close', () => {
    console.log('[shell] session', id, 'subscriber connection closed; subs left', session.subs.size - 1)
    session.subs.delete(res)
    // keep the shell alive while at least one subscriber remains; die with the last one
    if (session.subs.size === 0 && !session.closed) {
      session.closed = true
      sessions.delete(id)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
  })
}

function handleShellInput(req, res, url) {
  const id = url.searchParams.get('id')
  const session = id ? sessions.get(id) : undefined
  if (!session) return fail(res, 404, 'no such shell session')
  readBody(req, res, (body) => {
    if (session.closed || session.child.stdin.destroyed) return fail(res, 410, 'shell session is closed')
    session.child.stdin.write(body)
    sendJson(res, 200, { ok: true, bytes: body.length })
  })
}

function handleShellKill(req, res, url) {
  const id = url.searchParams.get('id')
  const session = id ? sessions.get(id) : undefined
  if (!session) return fail(res, 404, 'no such shell session')
  session.closed = true
  sessions.delete(id)
  try { session.child.kill('SIGKILL') } catch { /* ignore */ }
  sendJson(res, 200, { ok: true })
}

function handleDownload(req, res, url) {
  const raw = url.searchParams.get('path')
  if (!raw) return fail(res, 400, 'path parameter is required')
  let target
  try { target = resolve(raw) } catch { return fail(res, 400, 'invalid path') }
  let info
  try {
    info = statSync(target)
  } catch {
    return fail(res, 404, 'no such file: ' + target)
  }
  if (!info.isFile()) return fail(res, 400, 'not a regular file: ' + target)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'x-path': target })
  createReadStream(target).on('error', (error) => {
    try { res.end('[download error: ' + error.message + ']') } catch { /* ignore */ }
  }).pipe(res)
}

function handleUpload(req, res, url) {
  const raw = url.searchParams.get('path')
  if (!raw) return fail(res, 400, 'path parameter is required')
  let target
  try { target = resolve(raw) } catch { return fail(res, 400, 'invalid path') }
  try {
    mkdirSync(dirname(target), { recursive: true })
  } catch (error) {
    return fail(res, 500, 'cannot create parent directory: ' + error.message)
  }
  let size = 0
  let settled = false
  const out = createWriteStream(target)
  out.on('error', (error) => {
    if (!settled) {
      settled = true
      fail(res, 500, 'write failed: ' + error.message)
    }
  })
  req.on('data', (chunk) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_BODY) {
      settled = true
      fail(res, 413, 'body too large')
      req.destroy()
      try { unlinkSync(target) } catch { /* ignore */ }
      return
    }
    out.write(chunk)
  })
  req.on('end', () => {
    if (settled) return
    out.end(() => {
      settled = true
      sendJson(res, 200, { ok: true, bytes: size, path: target })
    })
  })
  req.on('error', () => {
    if (!settled) {
      settled = true
      fail(res, 400, 'request error')
      try { unlinkSync(target) } catch { /* ignore */ }
    }
  })
}

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error && error.stack ? error.stack : String(error))
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : String(reason))
})

const server = http.createServer((req, res) => {
  console.log('[req]', req.method, req.url)
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, version: 1, uptime: Math.round(process.uptime()) })
  if (!auth(req)) return fail(res, 401, 'unauthorized')
  try {
    if (req.method === 'POST' && url.pathname === '/exec') return readBody(req, res, (body) => handleExec(req, res, body))
    if (req.method === 'POST' && url.pathname === '/shell') return readBody(req, res, (body) => createShell(req, res, body))
    if (req.method === 'POST' && url.pathname === '/shell/input') return handleShellInput(req, res, url)
    if (req.method === 'POST' && url.pathname === '/shell/kill') return handleShellKill(req, res, url)
    if (req.method === 'GET' && url.pathname === '/download') return handleDownload(req, res, url)
    if (req.method === 'POST' && url.pathname === '/upload') return handleUpload(req, res, url)
    fail(res, 404, 'not found: ' + url.pathname)
  } catch (error) {
    fail(res, 500, 'internal error: ' + (error && error.message ? error.message : String(error)))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`dsh-agent listening on ${HOST}:${PORT}`)
})

process.on('SIGTERM', () => {
  for (const session of sessions.values()) {
    try { session.child.kill('SIGKILL') } catch { /* ignore */ }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
})
