'use strict'

/**
 * Handlers IPC : toute la logique réseau/fichiers vit ici (process main).
 * Le renderer ne reçoit que des événements d'état simples via
 * « session-event » et n'envoie que des commandes de haut niveau.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { ipcMain, dialog, app, shell, Notification, nativeImage, clipboard } = require('electron')
const QRCode = require('qrcode')
const { generateCode, normalizeCode } = require('./code')
const { SwarmSession, CODE_TTL_MS, MAX_AUTH_FAILURES } = require('./swarm')
const { TransferSender, TransferReceiver, cleanupAllPartFiles } = require('./transfer')

const MAX_FILES = 5000 // garde-fou : nombre de fichiers par transfert
const MAX_HISTORY = 50 // entrées d'historique conservées
const THUMB_MAX_FILES = 24 // au-delà, pas de miniatures (OFFER trop lourde)
const THUMB_SRC_MAX = 16 * 1024 * 1024 // on ne miniaturise pas une image énorme
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])

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

/** Dossier de cache des transferts partiels (reprise après coupure, #1). */
function resumeDir () {
  return path.join(app.getPath('userData'), 'partials')
}

/* --------------------------- historique -------------------------- */

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

/* ------------------------- notifications ------------------------- */

/**
 * Notification système, surtout utile quand la fenêtre est en arrière-plan.
 * Best-effort : silencieuse si l'OS ne les supporte pas.
 */
function notify (win, title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return
    if (win && !win.isDestroyed() && win.isFocused()) return // l'UI est déjà visible
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus() } })
    n.show()
  } catch {}
}

/* --------------------------- miniatures -------------------------- */

/**
 * Génère une petite miniature (data URL) pour un fichier image, via
 * nativeImage. Retourne null si ce n'est pas une image gérée, si elle est
 * trop grosse, ou en cas d'échec. Sert d'aperçu côté destinataire (#8).
 */
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
  // dispose() marque le transfert comme terminé et neutralise ses écouteurs
  // AVANT que la socket ne soit détruite : sans cela, le 'close' de la
  // FrameStream rappellerait _fail() → emit('error') sur un EventEmitter
  // sans listener (exception non gérée dans le process main).
  if (s.transfer) {
    try { await s.transfer.dispose() } catch {}
  }
  if (s.swarmSession) {
    s.swarmSession.removeAllListeners()
    await s.swarmSession.close().catch(() => {})
  }
}

/**
 * Étend une liste de chemins de haut niveau (fichiers et/ou dossiers) en
 * une liste plate d'entrées { path, relPath }. Les dossiers sont parcourus
 * récursivement, relPath conservant l'arborescence (séparateur « / »
 * canonique sur le réseau). Toute la résolution disque reste dans le main.
 */
async function expandEntries (paths) {
  const entries = []
  for (const p of paths) {
    const st = await fsp.stat(p).catch(() => null)
    if (!st) throw new Error(`Chemin introuvable : ${path.basename(String(p))}`)
    if (st.isFile()) {
      entries.push({ path: p, relPath: path.basename(p) })
    } else if (st.isDirectory()) {
      await walkDir(p, path.basename(p), entries)
    } else {
      throw new Error(`Élément non pris en charge : ${path.basename(p)}`)
    }
    if (entries.length > MAX_FILES) throw new Error(`Transfert trop volumineux (plus de ${MAX_FILES} fichiers).`)
  }
  if (entries.length === 0) throw new Error('Aucun fichier à envoyer (dossier vide ?).')
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
    // Liens symboliques et autres types ignorés (sécurité + simplicité).
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

async function startSend (win, paths, opts = {}) {
  await teardownSession()

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('Aucun fichier sélectionné.')
  }
  // Expansion des dossiers en arborescence de fichiers (avec leurs chemins
  // relatifs), et métadonnées résumées pour l'écran d'attente.
  const entries = await expandEntries(paths)
  const withThumbs = entries.length <= THUMB_MAX_FILES
  const filesMeta = []
  for (const e of entries) {
    const st = await fsp.stat(e.path)
    // Miniature pour les images (aperçu côté destinataire, #8).
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
    notify(win, 'NeoDrop', 'Le destinataire est connecté.')

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
      // Usage unique : le code meurt avec le transfert réussi.
      pushHistory({
        direction: 'send',
        folder: isFolder,
        count: filesMeta.length,
        totalSize: filesMeta.reduce((a, f) => a + f.size, 0),
        names: filesMeta.slice(0, 5).map((f) => f.name)
      })
      notify(win, 'NeoDrop', 'Transfert terminé avec succès.')
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
  // QR code du code d'appairage (scan rapide depuis un téléphone, #2).
  let qr = null
  try { qr = await QRCode.toDataURL(code, { margin: 1, width: 220 }) } catch {}
  return { code, qr, expiresAt: Date.now() + CODE_TTL_MS, files: filesMeta, folder: isFolder, passphrase: !!passphrase }
}

/* --------------------------- réception --------------------------- */

async function startReceive (win, rawCode, opts = {}) {
  await teardownSession()

  const code = normalizeCode(rawCode)
  if (!code) {
    throw new Error('Code invalide. Le format attendu est « MOT-1234 ».')
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
      notify(win, 'NeoDrop', `${offer.sender} veut vous envoyer des fichiers.`)
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
      notify(win, 'NeoDrop', `Fichiers reçus (${files.length}). Intégrité vérifiée.`)
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

  // Confirmation explicite du destinataire : rien ne s'écrit avant ça.
  ipcMain.handle('receive:accept', async (_e, destDir) => {
    if (!current || !current.transfer || current.role !== 'receiver') return { error: 'Aucun transfert en attente.' }
    const dir = typeof destDir === 'string' && destDir ? destDir : defaultDownloadDir()
    const cfg = loadConfig()
    cfg.defaultDir = dir // mémorise le dossier choisi pour la prochaine fois
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

  // Lecture du presse-papier : pré-remplissage du code côté destinataire (#7).
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
      title: 'Choisir les fichiers à envoyer',
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choisir le dossier à envoyer',
      properties: ['openDirectory']
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
  await cleanupAllPartFiles()
}

module.exports = { registerIpcHandlers, shutdown }
