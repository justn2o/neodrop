'use strict'

// NeoDrop mobile backend. Runs inside the embedded Node.js runtime
// (nodejs-mobile) and reuses the SAME protocol core as the desktop app
// (core/ is copied from ../../src/main by scripts/sync-core.sh). It talks to
// the React Native UI over the nodejs-mobile channel with JSON messages.

const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const rn = require('rn-bridge')

const { generateCode, normalizeCode } = require('./core/code')
const { SwarmSession, CODE_TTL_MS } = require('./core/swarm')
const { TransferSender, TransferReceiver, cleanupAllPartFiles } = require('./core/transfer')

const MAX_FILES = 5000
let current = null // { session, transfer, role }

function send (type, data = {}) {
  rn.channel.send(JSON.stringify({ type, data }))
}

async function teardown () {
  const s = current
  current = null
  if (!s) return
  if (s.transfer) { try { await s.transfer.dispose() } catch {} }
  if (s.session) { s.session.removeAllListeners(); await s.session.close().catch(() => {}) }
}

async function expandEntries (paths) {
  const entries = []
  const walk = async (dir, rel) => {
    for (const it of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entries.length > MAX_FILES) return
      const full = path.join(dir, it.name)
      if (it.isDirectory()) await walk(full, `${rel}/${it.name}`)
      else if (it.isFile()) entries.push({ path: full, relPath: `${rel}/${it.name}` })
    }
  }
  for (const p of paths) {
    const st = await fsp.stat(p)
    if (st.isFile()) entries.push({ path: p, relPath: path.basename(p) })
    else if (st.isDirectory()) await walk(p, path.basename(p))
  }
  if (entries.length === 0) throw new Error('No file to send.')
  return entries
}

function humanError (err) {
  const m = (err && err.message) || ''
  if (/ECONNRESET|EPIPE|ETIMEDOUT|destroyed|closed/i.test(m)) return 'The connection to the peer was lost.'
  if (/ENOSPC/.test(m)) return 'Not enough storage.'
  if (/EACCES|EPERM/.test(m)) return 'Access denied.'
  if (/ENOENT/.test(m)) return 'File not found.'
  if (m.length < 200) return m
  return 'An unexpected error occurred.'
}

async function startSend ({ paths, options = {} }) {
  await teardown()
  const entries = await expandEntries(paths)
  const passphrase = (options.passphrase || '').trim()
  const code = generateCode({ strength: options.strength || 'normal' })
  const session = new SwarmSession({ code, role: 'sender', passphrase })
  current = { session, transfer: null, role: 'sender' }

  session.on('peer-connected', () => send('peer-connected'))
  session.on('auth-failed', (d) => send('auth-failed', d))
  session.on('invalidated', () => { send('code-invalidated'); teardown() })
  session.on('expired', () => { send('code-expired'); teardown() })
  session.on('error', (e) => { send('error', { message: humanError(e) }); teardown() })

  session.on('peer-authenticated', ({ frames, connectionType }) => {
    send('peer-authenticated', { connectionType })
    const sender = new TransferSender(frames, entries, {
      senderName: os.hostname() || 'phone',
      compression: options.compression !== false,
      rateLimit: Number(options.rateLimit) > 0 ? Number(options.rateLimit) : 0
    })
    if (current) current.transfer = sender
    sender.on('offer-sent', (d) => send('waiting-confirmation', d))
    sender.on('accepted', () => send('transfer-started'))
    sender.on('rejected', () => { send('rejected'); teardown() })
    sender.on('progress', (p) => send('progress', p))
    sender.on('done', () => { send('done'); teardown() })
    sender.on('cancelled', (d) => { send('cancelled', d); teardown() })
    sender.on('error', (e) => { send('error', { message: humanError(e) }); teardown() })
    sender.start()
  })

  await session.start()
  const files = entries.map((e) => ({ name: path.basename(e.relPath), relPath: e.relPath }))
  send('send-started', { code, expiresAt: Date.now() + CODE_TTL_MS, files, folder: entries.some((e) => e.relPath.includes('/')) })
}

async function startReceive ({ code: raw, destDir, options = {} }) {
  await teardown()
  const code = normalizeCode(raw)
  if (!code) throw new Error('Invalid code. Expected format: WORD-1234.')
  const passphrase = (options.passphrase || '').trim()
  const session = new SwarmSession({ code, role: 'receiver', passphrase })
  current = { session, transfer: null, role: 'receiver', destDir }

  session.on('peer-connected', () => send('peer-connected'))
  session.on('timeout', () => { send('connect-timeout'); teardown() })
  session.on('auth-failed', () => send('auth-failed-receiver'))
  session.on('error', (e) => { send('error', { message: humanError(e) }); teardown() })

  session.on('peer-authenticated', ({ frames, connectionType }) => {
    send('peer-authenticated', { connectionType })
    const receiver = new TransferReceiver(frames, { resumeDir: path.join(destDir, '.neodrop-partials') })
    if (current) current.transfer = receiver
    receiver.on('offer', (offer) => send('offer', { ...offer, defaultDir: destDir }))
    receiver.on('progress', (p) => send('progress', p))
    receiver.on('done', ({ files }) => { send('done', { files }); setTimeout(() => teardown(), 1500) })
    receiver.on('cancelled', (d) => { send('cancelled', d); teardown() })
    receiver.on('error', (e) => { send('error', { message: humanError(e) }); teardown() })
  })

  await session.start()
  send('receive-started', {})
}

rn.channel.on('message', async (raw) => {
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  try {
    switch (msg.cmd) {
      case 'send': await startSend(msg); break
      case 'receive': await startReceive(msg); break
      case 'accept':
        if (current && current.transfer && current.role === 'receiver') await current.transfer.accept(msg.destDir || current.destDir)
        break
      case 'reject':
        if (current && current.transfer && current.role === 'receiver') current.transfer.reject()
        break
      case 'cancel':
        if (current && current.transfer) current.transfer.cancel(); else await teardown()
        break
    }
  } catch (err) {
    send('error', { message: humanError(err) })
    await teardown()
  }
})

process.on('exit', () => { cleanupAllPartFiles().catch(() => {}) })
rn.channel.send(JSON.stringify({ type: 'ready', data: {} }))
