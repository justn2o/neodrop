'use strict'

// IPC handlers: all network/file logic lives here (main process). The renderer
// only receives simple state events via "session-event" and sends high-level
// commands.

const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { ipcMain, dialog, app, shell, Notification, nativeImage, clipboard } = require('electron')
const QRCode = require('qrcode')
const { generateCode, normalizeCode } = require('./code')
const { SwarmSession, CODE_TTL_MS, MAX_AUTH_FAILURES } = require('./swarm')
const { TransferSender, TransferReceiver, cleanupAllPartFiles } = require('./transfer')

const MAX_FILES = 5000
const MAX_HISTORY = 50
const THUMB_MAX_FILES = 24
const THUMB_SRC_MAX = 16 * 1024 * 1024
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])

// Only one session (send OR receive) at a time.
let current = null

function configPath () {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig () {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig (cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
  } catch {}
}

function defaultDownloadDir () {
  const cfg = loadConfig()
  if (cfg.defaultDir && fs.existsSync(cfg.defaultDir)) return cfg.defaultDir
  return app.getPath('downloads')
}

function resumeDir () {
  return path.join(app.getPath('userData'), 'partials')
}

function loadHistory () {
  const cfg = loadConfig()
  return Array.isArray(cfg.history) ? cfg.history : []
}

function pushHistory (entry) {
  const cfg = loadConfig()
  const history = Array.isArray(cfg.history) ? cfg.history : []
  history.unshift({ at: Date.now(), ...entry })
  cfg.history = history.slice(0, MAX_HISTORY)
  saveConfig(cfg)
}

// System notification, useful when the window is in the background.
function notify (win, title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return
    if (win && !win.isDestroyed() && win.isFocused()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus() } })
    n.show()
  } catch {}
}

// Small thumbnail (data URL) for an image file, used as a preview on the
// recipient side. Returns null if not a supported image or on failure.
function makeThumb (filePath, size) {
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (!IMAGE_EXT.has(ext) || size > THUMB_SRC_MAX) return null
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (!width || !height) return null
    const scaled = img.resize({ height: Math.min(96, height) })
    const url = scaled.toDataURL()
    return (typeof url === 'string' && url.length < 180000) ? url : null
  } catch {
    return null
  }
}

function emitToRenderer (win, type, data = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('session-event', { type, data })
  }
}

async function teardownSession () {
  const s = current
  current = null
  if (!s) return
  if (s.transfer) {
    try { await s.transfer.dispose() } catch {}
  }
  if (s.swarmSession) {
    s.swarmSession.removeAllListeners()
    await s.swarmSession.close().catch(() => {})
  }
}

// Expands top-level paths (files and/or folders) into a flat list of
// { path, relPath } entries; folders are walked recursively.
async function expandEntries (paths) {
  const entries = []
  for (const p of paths) {
    const st = await fsp.stat(p).catch(() => null)
    if (!st) throw new Error(`Path not found: ${path.basename(String(p))}`)
    if (st.isFile()) {
      entries.push({ path: p, relPath: path.basename(p) })
    } else if (st.isDirectory()) {
      await walkDir(p, path.basename(p), entries)
    } else {
      throw new Error(`Unsupported item: ${path.basename(p)}`)
    }
    if (entries.length > MAX_FILES) throw new Error(`Transfer too large (more than ${MAX_FILES} files).`)
  }
  if (entries.length === 0) throw new Error('No file to send (empty folder?).')
  return entries
}

async function walkDir (dir, rel, entries) {
  const items = await fsp.readdir(dir, { withFileTypes: true })
  for (const it of items) {
    if (entries.length > MAX_FILES) return
    const full = path.join(dir, it.name)
    const childRel = `${rel}/${it.name}`
    if (it.isDirectory()) {
      await walkDir(full, childRel, entries)
    } else if (it.isFile()) {
      entries.push({ path: full, relPath: childRel })
    }
  }
}

// Turns an error into a human message - never a stack trace on screen.
function humanError (err) {
  const msg = (err && err.message) || ''
  if (/ECONNRESET|EPIPE|ETIMEDOUT|destroyed|closed/i.test(msg)) return 'The connection to the peer was lost.'
  if (/ENOSPC/.test(msg)) return 'Not enough disk space.'
  if (/EACCES|EPERM/.test(msg)) return 'Access denied to the destination folder.'
  if (/ENOENT/.test(msg)) return 'File or folder not found.'
  if (/^[A-Z"]/.test(msg) && !/^E[A-Z]+:/.test(msg) && msg.length < 200) return msg
  return 'An unexpected error occurred. Please try again.'
}

async function startSend (win, paths, opts = {}) {
  await teardownSession()

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('No file selected.')
  }
  const entries = await expandEntries(paths)
  const withThumbs = entries.length <= THUMB_MAX_FILES
  const filesMeta = []
  for (const e of entries) {
    const st = await fsp.stat(e.path)
    if (withThumbs) {
      const thumb = makeThumb(e.path, st.size)
      if (thumb) e.thumb = thumb
    }
    filesMeta.push({ name: path.basename(e.relPath), relPath: e.relPath, size: st.size, thumb: e.thumb || null })
  }
  const isFolder = entries.some((e) => e.relPath.includes('/'))

  const passphrase = typeof opts.passphrase === 'string' ? opts.passphrase.trim() : ''
  const strength = opts.strength || 'normal'
  const compression = opts.compression !== false
  const rateLimit = Number(opts.rateLimit) > 0 ? Number(opts.rateLimit) : 0

  const code = generateCode({ strength })
  const session = new SwarmSession({ code, role: 'sender', passphrase })
  current = { swarmSession: session, transfer: null, role: 'sender' }

  session.on('peer-connected', () => emitToRenderer(win, 'peer-connected'))
  session.on('auth-failed', ({ failures, remaining }) =>
    emitToRenderer(win, 'auth-failed', { failures, remaining }))
  session.on('invalidated', () => {
    emitToRenderer(win, 'code-invalidated', { maxFailures: MAX_AUTH_FAILURES })
    teardownSession()
  })
  session.on('expired', () => {
    emitToRenderer(win, 'code-expired')
    teardownSession()
  })
  session.on('error', (err) => {
    emitToRenderer(win, 'error', { message: humanError(err) })
    teardownSession()
  })

  session.on('peer-authenticated', ({ frames, connectionType }) => {
    emitToRenderer(win, 'peer-authenticated', { connectionType })
    notify(win, 'NeoDrop', 'The recipient is connected.')

    const sender = new TransferSender(frames, entries, {
      senderName: os.hostname(), compression, rateLimit
    })
    if (current) current.transfer = sender

    sender.on('offer-sent', ({ files, totalSize }) =>
      emitToRenderer(win, 'waiting-confirmation', { files, totalSize }))
    sender.on('accepted', () => emitToRenderer(win, 'transfer-started'))
    sender.on('rejected', () => {
      emitToRenderer(win, 'rejected')
      teardownSession()
    })
    sender.on('progress', (p) => emitToRenderer(win, 'progress', p))
    sender.on('file-done', (f) => emitToRenderer(win, 'file-done', f))
    sender.on('done', () => {
      pushHistory({
        direction: 'send',
        folder: isFolder,
        count: filesMeta.length,
        totalSize: filesMeta.reduce((a, f) => a + f.size, 0),
        names: filesMeta.slice(0, 5).map((f) => f.name)
      })
      notify(win, 'NeoDrop', 'Transfer completed successfully.')
      emitToRenderer(win, 'done')
      teardownSession()
    })
    sender.on('cancelled', ({ by }) => {
      emitToRenderer(win, 'cancelled', { by })
      teardownSession()
    })
    sender.on('error', (err) => {
      emitToRenderer(win, 'error', { message: humanError(err) })
      teardownSession()
    })

    sender.start()
  })

  await session.start()
  let qr = null
  try { qr = await QRCode.toDataURL(code, { margin: 1, width: 220 }) } catch {}
  return { code, qr, expiresAt: Date.now() + CODE_TTL_MS, files: filesMeta, folder: isFolder, passphrase: !!passphrase }
}

async function startReceive (win, rawCode, opts = {}) {
  await teardownSession()

  const code = normalizeCode(rawCode)
  if (!code) {
    throw new Error('Invalid code. Expected format: WORD-1234.')
  }
  const passphrase = typeof opts.passphrase === 'string' ? opts.passphrase.trim() : ''

  const session = new SwarmSession({ code, role: 'receiver', passphrase })
  current = { swarmSession: session, transfer: null, role: 'receiver' }

  session.on('peer-connected', () => emitToRenderer(win, 'peer-connected'))
  session.on('timeout', () => {
    emitToRenderer(win, 'connect-timeout')
    teardownSession()
  })
  session.on('auth-failed', () =>
    emitToRenderer(win, 'auth-failed-receiver'))
  session.on('error', (err) => {
    emitToRenderer(win, 'error', { message: humanError(err) })
    teardownSession()
  })

  session.on('peer-authenticated', ({ frames, connectionType }) => {
    emitToRenderer(win, 'peer-authenticated', { connectionType })

    const receiver = new TransferReceiver(frames, { resumeDir: resumeDir() })
    if (current) current.transfer = receiver

    receiver.on('offer', (offer) => {
      notify(win, 'NeoDrop', `${offer.sender} wants to send you files.`)
      emitToRenderer(win, 'offer', { ...offer, defaultDir: defaultDownloadDir() })
    })
    receiver.on('progress', (p) => emitToRenderer(win, 'progress', p))
    receiver.on('file-done', (f) => emitToRenderer(win, 'file-done', f))
    receiver.on('done', ({ files }) => {
      pushHistory({
        direction: 'receive',
        count: files.length,
        totalSize: files.reduce((a, f) => a + (f.size || 0), 0),
        names: files.slice(0, 5).map((f) => f.name)
      })
      notify(win, 'NeoDrop', `Files received (${files.length}). Integrity verified.`)
      emitToRenderer(win, 'done', { files })
      // Let the sender receive the DONE_ACK and close cleanly before teardown.
      setTimeout(() => teardownSession(), 1500)
    })
    receiver.on('cancelled', ({ by, rejected }) => {
      emitToRenderer(win, 'cancelled', { by, rejected })
      teardownSession()
    })
    receiver.on('error', (err) => {
      emitToRenderer(win, 'error', { message: humanError(err) })
      teardownSession()
    })
  })

  await session.start()
  return { ok: true }
}

function registerIpcHandlers (getWindow) {
  ipcMain.handle('send:start', async (_e, filePaths, opts) => {
    try {
      return await startSend(getWindow(), filePaths, opts || {})
    } catch (err) {
      return { error: humanError(err) }
    }
  })

  ipcMain.handle('receive:start', async (_e, code, opts) => {
    try {
      return await startReceive(getWindow(), code, opts || {})
    } catch (err) {
      return { error: humanError(err) }
    }
  })

  ipcMain.handle('receive:accept', async (_e, destDir) => {
    if (!current || !current.transfer || current.role !== 'receiver') return { error: 'No pending transfer.' }
    const dir = typeof destDir === 'string' && destDir ? destDir : defaultDownloadDir()
    const cfg = loadConfig()
    cfg.defaultDir = dir
    saveConfig(cfg)
    await current.transfer.accept(dir)
    return { ok: true }
  })

  ipcMain.handle('history:get', async () => loadHistory())

  ipcMain.handle('history:clear', async () => {
    const cfg = loadConfig()
    delete cfg.history
    saveConfig(cfg)
    return { ok: true }
  })

  ipcMain.handle('clipboard:read', async () => {
    try { return clipboard.readText() } catch { return '' }
  })

  ipcMain.handle('receive:reject', async () => {
    if (current && current.transfer && current.role === 'receiver') current.transfer.reject()
    return { ok: true }
  })

  ipcMain.handle('session:cancel', async () => {
    if (current && current.transfer) {
      current.transfer.cancel()
    } else {
      await teardownSession()
    }
    return { ok: true }
  })

  ipcMain.handle('dialog:chooseFiles', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose files to send',
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a folder to send',
      properties: ['openDirectory']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:chooseDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose the destination folder',
      defaultPath: defaultDownloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('config:getDefaultDir', async () => defaultDownloadDir())

  ipcMain.handle('shell:showInFolder', async (_e, p) => {
    if (typeof p === 'string') shell.showItemInFolder(p)
    return { ok: true }
  })
}

async function shutdown () {
  await teardownSession()
  await cleanupAllPartFiles()
}

module.exports = { registerIpcHandlers, shutdown }
