// dsh-remote — OpenSSH `ProxyCommand` support for the NATIVE backend.
//
// ## Why this module exists
//
// The native backend (lib/pool.js) speaks SSH itself through ssh2, so it needs a
// transport. Until now the only transports were a direct TCP socket and one
// `ProxyJump` hop (ssh2 forwardOut through a bastion). Hosts whose ssh_config
// uses `ProxyCommand` (cloudflared, nc, socat, `ssh -W`, docker exec …) could
// only be reached with `backend: openssh`, which spawns the local ssh CLI and
// therefore pays a fresh handshake per command.
//
// This module closes that gap: it expands the ProxyCommand the way OpenSSH does
// and runs it locally, handing ssh2 the child process's stdio as the SSH
// transport (ssh2's `sock` option). ssh2's full SSH implementation stays in
// charge of the protocol; the command is only the byte pipe.
//
// ## What is implemented
//
//   • Token expansion: %h (host), %n (original host/alias), %p (port),
//     %r (remote user), %L (local hostname), %% (literal percent). Unknown
//     tokens are left verbatim rather than throwing: a config written for a
//     newer OpenSSH must not make the host unreachable.
//   • `none` / empty → no proxy (ssh_config semantics).
//   • POSIX: /bin/sh -c <command>; Windows: %ComSpec% /d /s /c <command>.
//     The command is a SHELL string by definition, so quoting is the shell's.
//   • Lifecycle: the returned Duplex owns the child; destroying the stream kills
//     the process, and a non-zero exit turns into a stream error so the SSH
//     handshake fails with the command's exit code instead of hanging.

import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { hostname } from 'node:os'

/**
 * Expand an OpenSSH ProxyCommand template.
 *
 * @param {string} template - the raw ProxyCommand value.
 * @param {{host?: string, port?: number|string, user?: string, originalHost?: string, localHost?: string}} ctx
 * @returns {string} the command line, or '' when there is nothing to run.
 */
export function expandProxyCommand(template, ctx = {}) {
  const raw = String(template || '').trim()
  if (!raw || /^none$/i.test(raw)) return ''
  const host = String(ctx.host || '')
  const originalHost = String(ctx.originalHost || host)
  const port = String(ctx.port === undefined || ctx.port === null || ctx.port === '' ? '' : ctx.port)
  const user = String(ctx.user || '')
  const localHost = String(ctx.localHost || hostname() || 'localhost')
  // One pass, left to right: %h must not be re-expanded into another token, so
  // a single regex replacement is the safe implementation (not repeated .replace).
  return raw.replace(/%([%hnprL])/g, (m, tok) => {
    switch (tok) {
      case '%': return '%'
      case 'h': return host
      case 'n': return originalHost
      case 'p': return port
      case 'r': return user
      case 'L': return localHost
      default: return m
    }
  })
}

/**
 * The shell that runs a ProxyCommand on this platform.
 * @returns {{file: string, args: string[]}}
 */
export function proxyShell() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c'] }
  }
  return { file: '/bin/sh', args: ['-c'] }
}

/**
 * Run a ProxyCommand and expose its stdio as a SSH transport stream.
 *
 * @param {string} command - the EXPANDED command line.
 * @param {{env?: object, onStderr?: (text: string) => void, stdin?: boolean}} [opts]
 * @returns {{stream: Duplex, child: object, kill: Function, pid: number|undefined}}
 */
export function spawnProxyCommand(command, opts = {}) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('ProxyCommand is empty')
  const shell = proxyShell()
  const child = spawn(shell.file, [...shell.args, cmd], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env || process.env,
    windowsHide: true,
  })

  let ended = false
  let killed = false
  let stderrTail = ''
  const stream = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      // The child can be gone (crash, user kill) between two writes: EPIPE must
      // come back as a callback error, not as an unhandled 'error' on stdin.
      if (killed || !child.stdin.writable) { done(new Error('ProxyCommand stdin is closed')); return }
      try { child.stdin.write(chunk, done) } catch (err) { done(err) }
    },
    final(done) {
      try { child.stdin.end(done) } catch { done() }
    },
    destroy(err, done) {
      try { child.kill() } catch {}
      done(err)
    },
  })

  const pushEnd = () => {
    if (ended) return
    ended = true
    try { stream.push(null) } catch {}
  }
  const fail = (message) => {
    if (ended) return
    ended = true
    // Prefer the captured stderr: for nc/socat/cloudflared the reason a proxy
    // failed (DNS, TLS, auth) is ONLY on stderr, and ssh2 would otherwise
    // report a bare "connection closed".
    const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
    try { stream.destroy(new Error(`${message}${detail}`)) } catch {}
  }

  // A consumer (ssh2) attaches its own 'error' listener when the handshake
  // starts, but the window between spawn and client.connect() is real: a command
  // that dies immediately would otherwise crash the host process with an
  // unhandled 'error'. The guard keeps the stream safe to hand around.
  stream.on('error', () => {})
  // Every stdio socket gets an error handler: a proxy that dies mid-handshake
  // otherwise crashes the host process with EPIPE from stdin or stdout.
  child.stdin.on('error', (err) => { if (!killed) fail('ProxyCommand stdin error: ' + ((err && err.message) || err)) })
  child.stdout.on('error', (err) => { if (!killed) fail('ProxyCommand stdout error: ' + ((err && err.message) || err)) })
  child.stderr.on('error', () => {})
  child.stdout.on('data', (d) => { if (!ended) stream.push(d) })
  // The exit status is authoritative: stdout can end before `close` (the shell
  // still has to reap), and ending the stream there would hide a non-zero exit
  // behind a clean EOF. `close` fires once both stdio and the process are done.
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + String(d)).slice(-2000)
    if (opts.onStderr) { try { opts.onStderr(String(d)) } catch {} }
  })
  child.on('error', (err) => fail(`ProxyCommand could not start (${shell.file}): ${(err && err.message) || err}`))
  child.on('close', (code, signal) => {
    if (killed) return          // intentional teardown: not an error
    if (code === 0) { pushEnd(); return }
    fail(`ProxyCommand exited with ${code === null ? `signal ${signal}` : `code ${code}`}`)
  })

  return {
    stream,
    child,
    pid: child.pid,
    kill: () => {
      killed = true
      ended = true
      try { child.kill() } catch {}
    },
  }
}
