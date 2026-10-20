#!/usr/bin/env node
// Integration probe for the NATIVE backend's proxy transports (issue #51 follow-up).
//
// Starts two in-process SSH servers (ssh2's Server) so nothing external is
// needed — no sshd, no container, no network:
//
//   target   — accepts password auth and runs 'probe';
//   bastion  — accepts password auth and forwards direct-tcpip channels
//              (server.on('tcpip')), which is what ProxyJump uses.
//
// Then it connects through BOTH transports and asserts each reaches the target:
//
//   1. ProxyCommand: 'nc 127.0.0.1 <target-port>'   (lib/proxycommand.js)
//   2. ProxyJump:    proxyChain = [bastion]         (pool._openProxyChain)
//
// Exit code 0 = both transports work; non-zero = at least one failed.

import ssh2 from 'ssh2'
import net from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { SshPool } from '../lib/pool.js'

const { Server } = ssh2
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const makeServer = (onReady) => new Promise((resolve) => {
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') ctx.accept()
      else ctx.reject()
    })
    client.on('ready', () => onReady(client))
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

const target = await makeServer((client) => client.on('session', (accept) => {
  const session = accept()
  session.on('exec', (acceptExec) => {
    const stream = acceptExec()
    stream.write('remote-ok\n')
    setTimeout(() => { stream.exit(0); stream.end() }, 100)
  })
}))

const bastion = await makeServer((client) => client.on('tcpip', (accept, reject, info) => {
  const channel = accept()
  const socket = net.connect(info.destPort, info.destIP, () => {
    channel.pipe(socket).pipe(channel)
  })
  socket.on('error', () => { try { channel.close() } catch {} })
}))

const baseConfig = (extra) => ({
  host: '127.0.0.1',
  port: target.port,
  username: 'u',
  password: 'p',
  hostKeyMode: 'off',
  connectTimeoutMs: 5000,
  commandTimeoutMs: 5000,
  ...extra,
})

const attempt = async (label, extra) => {
  const pool = new SshPool(baseConfig(extra))
  try {
    await pool.connect()
    const result = await pool.exec('probe')
    const ok = result.code === 0
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
    return ok
  } catch (err) {
    console.log('FAIL  ' + label + ': ' + String((err && err.message) || err).slice(0, 160))
    return false
  } finally {
    try { pool.close() } catch {}
  }
}

const viaCommand = await attempt('ProxyCommand (nc)', {
  proxyCommand: 'nc 127.0.0.1 ' + target.port,
})
const viaChain = await attempt('ProxyJump (bastion, single hop)', {
  proxyChain: [{ host: '127.0.0.1', port: bastion.port, username: 'u', password: 'p' }],
})

await new Promise((r) => setTimeout(r, 300))
target.server.close()
bastion.server.close()
console.log('')
console.log('ProxyCommand: ' + (viaCommand ? 'honoured' : 'NOT honoured'))
console.log('ProxyJump:    ' + (viaChain ? 'honoured' : 'NOT honoured'))
process.exit(viaCommand && viaChain ? 0 : 1)
