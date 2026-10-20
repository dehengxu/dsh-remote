// ProxyCommand transport for the NATIVE backend (issue #51 follow-up).
//
// Part A pins OpenSSH token expansion (pure).
// Part B proves the spawned command really becomes a byte pipe: stdout flows
// through the Duplex, a non-zero exit surfaces as a stream error carrying the
// command's stderr, and destroying the stream kills the process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandProxyCommand, proxyShell, spawnProxyCommand } from '../lib/proxycommand.js'

test('expandProxyCommand: %h/%n/%p/%r tokens, and %% as a literal percent', () => {
  const out = expandProxyCommand('nc -X connect %h %p', { host: 'h.example', port: 22 })
  assert.equal(out, 'nc -X connect h.example 22')
  const all = expandProxyCommand('a %n b %r c %L d 100%%', {
    host: 'HOST', originalHost: 'alias', user: 'me', localHost: 'LOCAL',
  })
  assert.equal(all, 'a alias b me c LOCAL d 100%')
})

test('expandProxyCommand: empty and "none" mean no proxy', () => {
  assert.equal(expandProxyCommand(''), '')
  assert.equal(expandProxyCommand('   '), '')
  assert.equal(expandProxyCommand('none'), '')
  assert.equal(expandProxyCommand('NONE'), '')
})

test('expandProxyCommand: unknown tokens stay verbatim (forward compatible)', () => {
  assert.equal(expandProxyCommand('echo %z %C %T', { host: 'h', port: 1 }), 'echo %z %C %T')
})

test('proxyShell: POSIX uses /bin/sh -c', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(proxyShell(), { file: '/bin/sh', args: ['-c'] })
})

test('spawnProxyCommand: stdout becomes the transport; destroying kills it', async () => {
  const spawned = spawnProxyCommand('sh -c "printf hello-proxy; sleep 5"')
  let out = ''
  spawned.stream.on('data', (d) => { out += String(d) })
  await new Promise((r) => setTimeout(r, 300))
  assert.match(out, /hello-proxy/)
  spawned.stream.destroy()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(spawned.child.exitCode !== null || spawned.child.killed, true)
})

test('spawnProxyCommand: a non-zero exit is a stream error that carries stderr', async () => {
  const spawned = spawnProxyCommand('sh -c "echo boom >&2; exit 3"')
  const err = await new Promise((resolve) => {
    spawned.stream.on('error', resolve)
    spawned.stream.on('end', () => resolve(new Error('ended without error')))
    spawned.stream.resume()
  })
  assert.match(String(err.message), /code 3/)
  assert.match(String(err.message), /boom/)
})

test('spawnProxyCommand: an empty command is rejected loudly', () => {
  assert.throws(() => spawnProxyCommand(''), /ProxyCommand is empty/)
})