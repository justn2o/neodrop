'use strict'

/**
 * Handlers IPC : toute la logique réseau/fichiers vit ici (process main).
 * Le renderer ne reçoit que des événements d'état simples via
 * « session-event » et n'envoie que des commandes de haut niveau.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { ipcMain, dialog, app, shell } = require('electron')
const { generateCode, normalizeCode } = require('./code')
const { SwarmSession, CODE_TTL_MS, MAX_AUTH_FAILURES } = require('./swarm')
const { TransferSender, TransferReceiver, cleanupAllPartFiles } = require('./transfer')

// Une seule session (envoi OU réception) à la fois : c'est le parcours
// voulu, et cela simplifie tous les états d'erreur.
let current = null // { swarmSession, transfer, role }

/* ------------------------- configuration ------------------------- */

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

/* --------------------------- helpers ----------------------------- */

function emitToRenderer (win, type, data = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('session-event', { type, data })
  }
}

async function teardownSession () {
  const s = current
  current = null
  if (!s) return
  try { if (s.transfer) s.transfer.removeAllListeners() } catch {}
  if (s.swarmSession) {
    s.swarmSession.removeAllListeners()
    await s.swarmSession.close().catch(() => {})
  }
}

/** Traduit une erreur en message humain — jamais de stack trace à l'écran. */
function humanError (err) {
  const msg = (err && err.message) || ''
  // Erreurs système d'abord (codes ENOENT, ECONNRESET…).
  if (/ECONNRESET|EPIPE|ETIMEDOUT|destroyed|closed/i.test(msg)) return 'La connexion avec le pair a été perdue.'
  if (/ENOSPC/.test(msg)) return 'Espace disque insuffisant.'
  if (/EACCES|EPERM/.test(msg)) return 'Accès refusé au dossier de destination.'
  if (/ENOENT/.test(msg)) return 'Fichier ou dossier introuvable.'
  // Les messages de notre propre protocole sont déjà en français.
  if (/^[A-ZÀ-Ü«]/.test(msg) && !/^E[A-Z]+:/.test(msg) && msg.length < 200) return msg
  return 'Une erreur inattendue est survenue. Réessaie.'
}

/* ----------------------------- envoi ----------------------------- */

async function startSend (win, filePaths) {
  await teardownSession()

  // Validation des chemins avant tout.
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('Aucun fichier sélectionné.')
  }
  const filesMeta = []
  for (const p of filePaths) {
    const st = fs.statSync(p, { throwIfNoEntry: false })
    if (!st || !st.isFile()) throw new Error(`Fichier introuvable : ${path.basename(String(p))}`)
    filesMeta.push({ name: path.basename(p), size: st.size })
  }

  const code = generateCode()
  const session = new SwarmSession({ code, role: 'sender' })
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

    const sender = new TransferSender(frames, filePaths, { senderName: os.hostname() })
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
      // Usage unique : le code meurt avec le transfert réussi.
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
  return { code, expiresAt: Date.now() + CODE_TTL_MS, files: filesMeta }
}

/* --------------------------- réception --------------------------- */

async function startReceive (win, rawCode) {
  await teardownSession()

  const code = normalizeCode(rawCode)
  if (!code) {
    throw new Error('Code invalide. Le format attendu est « MOT-1234 ».')
  }

  const session = new SwarmSession({ code, role: 'receiver' })
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

    const receiver = new TransferReceiver(frames)
    if (current) current.transfer = receiver

    receiver.on('offer', (offer) =>
      emitToRenderer(win, 'offer', { ...offer, defaultDir: defaultDownloadDir() }))
    receiver.on('progress', (p) => emitToRenderer(win, 'progress', p))
    receiver.on('file-done', (f) => emitToRenderer(win, 'file-done', f))
    receiver.on('done', ({ files }) => {
      emitToRenderer(win, 'done', { files })
      teardownSession()
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

/* ------------------------- enregistrement ------------------------ */

function registerIpcHandlers (getWindow) {
  ipcMain.handle('send:start', async (_e, filePaths) => {
    try {
      return await startSend(getWindow(), filePaths)
    } catch (err) {
      return { error: humanError(err) }
    }
  })

  ipcMain.handle('receive:start', async (_e, code) => {
    try {
      return await startReceive(getWindow(), code)
    } catch (err) {
      return { error: humanError(err) }
    }
  })

  // Confirmation explicite du destinataire : rien ne s'écrit avant ça.
  ipcMain.handle('receive:accept', async (_e, destDir) => {
    if (!current || !current.transfer || current.role !== 'receiver') return { error: 'Aucun transfert en attente.' }
    const dir = typeof destDir === 'string' && destDir ? destDir : defaultDownloadDir()
    const cfg = loadConfig()
    cfg.defaultDir = dir // mémorise le dossier choisi pour la prochaine fois
    saveConfig(cfg)
    current.transfer.accept(dir)
    return { ok: true }
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
      title: 'Choisir les fichiers à envoyer',
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:chooseDir', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choisir le dossier de destination',
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

/** À appeler à la fermeture de l'app : coupe tout et nettoie les .part. */
async function shutdown () {
  await teardownSession()
  cleanupAllPartFiles()
}

module.exports = { registerIpcHandlers, shutdown }
