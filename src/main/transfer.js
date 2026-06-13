'use strict'

/**
 * Protocole de transfert de fichiers au-dessus d'une socket Hyperswarm
 * (déjà chiffrée bout-en-bout par Noise, et authentifiée par le
 * challenge-réponse de swarm.js).
 *
 * Framing length-prefixed : [longueur u32 BE][type u8][payload]
 *   type 0 = message de contrôle JSON
 *   type 1 = bloc binaire de données fichier (64 Ko max)
 *
 * Déroulé :
 *   S → R : OFFER  { files: [{id, name, size, sha256|null}], sender }
 *   R → S : ACCEPT | REJECT          (après confirmation utilisateur)
 *   pour chaque fichier, séquentiellement :
 *     S → R : FILE_START {id}
 *     S → R : CHUNK (binaire) × n    (backpressure : write() false → pause)
 *     S → R : FILE_END {id, sha256}  (hash calculé en streaming pendant l'envoi)
 *     R → S : FILE_OK {id} | FILE_FAIL {id, reason}
 *   S → R : DONE   /   R → S : DONE_ACK
 *   CANCEL peut être émis par les deux côtés à tout moment.
 *
 * Côté réception : écriture en streaming dans « <nom>.part », renommage
 * seulement après vérification du SHA-256. Jamais de fichier entier en RAM.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const b4a = require('b4a')

const CHUNK_SIZE = 64 * 1024
const MAX_JSON_FRAME = 4 * 1024 * 1024 // OFFER d'un gros dossier (5000 fichiers)
const MAX_CHUNK_FRAME = CHUNK_SIZE + 16
const HASH_PRECOMPUTE_LIMIT = 500 * 1024 * 1024 // < 500 Mo : SHA-256 avant envoi
const HASH_PRECOMPUTE_MAX_FILES = 20 // au-delà, OFFER immédiat (hash au fil de l'envoi)
const PROGRESS_INTERVAL = 200 // ms entre deux événements de progression

// Timeouts protocolaires : un pair authentifié mais muet ne doit jamais
// bloquer l'UI indéfiniment (le keep-alive ne détecte que les pairs morts).
const OFFER_TIMEOUT = 30 * 1000 // réception : attente des détails du transfert
const ACCEPT_TIMEOUT = 5 * 60 * 1000 // envoi : le destinataire doit confirmer
const ACK_TIMEOUT = 60 * 1000 // envoi : attente d'un FILE_OK / DONE_ACK
const IDLE_TIMEOUT = 60 * 1000 // réception : silence en plein transfert

const FRAME_JSON = 0
const FRAME_CHUNK = 1

// Registre global des fichiers temporaires en cours d'écriture
// (chemin .part → WriteStream), pour pouvoir fermer les flux PUIS
// supprimer les fichiers si l'application se ferme en plein transfert.
// (Sous Windows, unlink échoue tant que le fichier est ouvert.)
const activeParts = new Map()

async function cleanupAllPartFiles () {
  const entries = [...activeParts.entries()]
  activeParts.clear()
  await Promise.all(entries.map(async ([p, ws]) => {
    if (ws && !ws.closed) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1000)
        ws.once('close', () => { clearTimeout(t); resolve() })
        try { ws.destroy() } catch { clearTimeout(t); resolve() }
      })
    }
    await fsp.unlink(p).catch(() => {})
  }))
}

/* ------------------------------------------------------------------ */
/* Framing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Enveloppe une socket duplex en flux de trames typées.
 * Émet : 'json' (message de contrôle), 'chunk' (Buffer), 'error', 'close'.
 */
class FrameStream extends EventEmitter {
  constructor (socket) {
    super()
    this.socket = socket
    this._buffer = b4a.alloc(0)
    this._destroyed = false

    socket.on('data', (data) => this._onData(data))
    socket.on('error', (err) => this._fail(err))
    socket.on('close', () => {
      this._destroyed = true
      this.emit('close')
    })
  }

  _onData (data) {
    if (this._destroyed) return
    this._buffer = this._buffer.length === 0 ? data : b4a.concat([this._buffer, data])
    // Une trame = 4 octets de longueur + (1 octet de type + payload).
    while (this._buffer.length >= 4) {
      const len = readUInt32BE(this._buffer, 0)
      // Borne haute = la plus grande des deux limites (JSON de contrôle ou
      // bloc de données) ; le type est vérifié plus finement juste après.
      if (len < 1 || len > MAX_JSON_FRAME + 1) {
        this._fail(new Error('Trame invalide reçue du pair'))
        return
      }
      if (this._buffer.length < 4 + len) break
      const type = this._buffer[4]
      const payload = this._buffer.subarray(5, 4 + len)
      this._buffer = b4a.from(this._buffer.subarray(4 + len)) // libère le buffer parent
      if (type === FRAME_JSON) {
        if (len > MAX_JSON_FRAME) {
          this._fail(new Error('Message de contrôle trop volumineux'))
          return
        }
        let msg
        try {
          msg = JSON.parse(b4a.toString(payload, 'utf8'))
        } catch {
          this._fail(new Error('Message de contrôle illisible'))
          return
        }
        this.emit('json', msg)
      } else if (type === FRAME_CHUNK) {
        if (len > MAX_CHUNK_FRAME) {
          this._fail(new Error('Bloc de données trop volumineux'))
          return
        }
        // Copie : payload pointe dans le buffer de réassemblage réutilisé.
        this.emit('chunk', b4a.from(payload))
      } else {
        this._fail(new Error('Type de trame inconnu'))
        return
      }
    }
  }

  /** Envoie un message JSON. Retourne false si le tampon d'envoi est plein. */
  sendJson (obj) {
    return this._write(FRAME_JSON, b4a.from(JSON.stringify(obj), 'utf8'))
  }

  /** Envoie un bloc binaire. Retourne false si le tampon d'envoi est plein. */
  sendChunk (buf) {
    return this._write(FRAME_CHUNK, buf)
  }

  _write (type, payload) {
    if (this._destroyed) return false
    // En-tête + payload en une seule écriture : évite de doubler les
    // appels système (et les paquets) sur le chemin chaud des chunks.
    const frame = b4a.alloc(5 + payload.length)
    writeUInt32BE(frame, payload.length + 1, 0)
    frame[4] = type
    frame.set(payload, 5)
    return this.socket.write(frame)
  }

  /** Attend que le tampon d'envoi de la socket se vide (backpressure). */
  waitDrain () {
    return new Promise((resolve) => {
      if (this._destroyed) return resolve()
      this.socket.once('drain', resolve)
    })
  }

  pause () { if (!this._destroyed && this.socket.pause) this.socket.pause() }
  resume () { if (!this._destroyed && this.socket.resume) this.socket.resume() }

  _fail (err) {
    if (this._destroyed) return
    this._destroyed = true
    this.emit('error', err)
  }

  /**
   * Ferme proprement : laisse partir les octets déjà mis en file (un
   * éventuel CANCEL/REJECT), puis détruit. Remplace les setTimeout devinés.
   */
  endGracefully () {
    if (this._destroyed) return
    this._destroyed = true
    try {
      this.socket.end(() => { try { this.socket.destroy() } catch {} })
      // Filet de sécurité si le 'finish' n'arrive jamais (pair muet).
      setTimeout(() => { try { this.socket.destroy() } catch {} }, 3000).unref?.()
    } catch {
      try { this.socket.destroy() } catch {}
    }
  }

  destroy () {
    if (this._destroyed) return
    this._destroyed = true
    try { this.socket.destroy() } catch {}
  }

  get destroyed () { return this._destroyed }
}

function readUInt32BE (buf, off) {
  return (buf[off] * 0x1000000) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3]
}

function writeUInt32BE (buf, value, off) {
  buf[off] = (value >>> 24) & 0xff
  buf[off + 1] = (value >>> 16) & 0xff
  buf[off + 2] = (value >>> 8) & 0xff
  buf[off + 3] = value & 0xff
}

/* ------------------------------------------------------------------ */
/* Utilitaires fichiers                                                 */
/* ------------------------------------------------------------------ */

// Noms réservés par Windows, interdits même avec une extension.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Nettoie un nom de fichier reçu du réseau : on ne garde que le nom de
 * base (aucun chemin, donc aucun « ../ » possible), on retire les
 * caractères interdits sous Windows et les noms réservés.
 */
function sanitizeFilename (name) {
  let s = String(name)
  // Ne garder que la dernière composante, quel que soit le séparateur.
  s = s.split(/[/\\]/).pop() || ''
  // Caractères interdits Windows + caractères de contrôle.
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  // Points et espaces en fin de nom : interdits sous Windows.
  s = s.replace(/[. ]+$/g, '')
  if (s === '' || s === '.' || s === '..') s = 'fichier'
  const base = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s
  if (WINDOWS_RESERVED.test(base)) s = '_' + s
  // Borne la longueur (limite usuelle des systèmes de fichiers).
  if (s.length > 200) {
    const ext = s.includes('.') ? s.slice(s.lastIndexOf('.')) : ''
    s = s.slice(0, 200 - ext.length) + ext
  }
  return s
}

/**
 * Assainit un chemin RELATIF reçu pour un transfert de dossier :
 * chaque composante est passée dans sanitizeFilename (ce qui neutralise
 * « .. », les séparateurs et les caractères interdits), puis recollée avec
 * le séparateur de la plateforme. Le résultat ne peut jamais sortir du
 * dossier de destination. Retourne null si le chemin est entièrement vide.
 */
function sanitizeRelPath (relPath) {
  const parts = String(relPath)
    .split(/[/\\]/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .map((p) => sanitizeFilename(p))
  if (parts.length === 0) return null
  return parts.join(path.sep)
}

/**
 * Trouve un chemin libre. Pour un fichier seul, suffixe « (1) » sur le nom.
 * Pour un fichier dans un dossier reçu (relPath avec sous-dossiers), c'est
 * le dossier RACINE qui est suffixé une seule fois, afin que toute
 * l'arborescence reçue reste regroupée et cohérente.
 */
async function uniquePath (destDir, relPath) {
  const segments = relPath.split(path.sep)
  if (segments.length === 1) {
    return uniqueLeaf(destDir, relPath)
  }
  // Dossier : réserve un nom de racine libre, puis garde l'arbo dessous.
  const root = await reserveRootDir(destDir, segments[0])
  return path.join(destDir, root, ...segments.slice(1))
}

/** Réserve un nom de dossier racine libre (« dossier », « dossier (1) »…). */
async function reserveRootDir (destDir, name) {
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${name} (${i})`
    if (!await pathExists(path.join(destDir, candidate))) return candidate
  }
  throw new Error('Impossible de trouver un nom de dossier libre')
}

/** Trouve un chemin libre pour un fichier feuille : « x.ext », « x (1).ext ». */
async function uniqueLeaf (dir, name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = ext ? name.slice(0, name.length - ext.length) : name
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`
    const full = path.join(dir, candidate)
    const taken = await pathExists(full) || await pathExists(full + '.part')
    if (!taken) return full
  }
  throw new Error('Impossible de trouver un nom de fichier libre')
}

async function pathExists (p) {
  try { await fsp.access(p); return true } catch { return false }
}

/** SHA-256 d'un fichier en streaming (jamais le fichier entier en RAM). */
function hashFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    rs.on('data', (d) => hash.update(d))
    rs.on('error', reject)
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/* ------------------------------------------------------------------ */
/* Suivi de progression                                                 */
/* ------------------------------------------------------------------ */

class ProgressTracker {
  constructor (totalSize, emit) {
    this.totalSize = totalSize
    this.totalBytes = 0
    this.emitFn = emit
    this.lastEmit = 0
    this.window = [] // [timestamp, totalBytes] pour la vitesse glissante
  }

  update (file, fileBytes, deltaBytes, force = false) {
    this.totalBytes += deltaBytes
    const now = Date.now()
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL) return
    this.lastEmit = now

    this.window.push([now, this.totalBytes])
    while (this.window.length > 1 && now - this.window[0][0] > 3000) this.window.shift()
    let speed = 0
    if (this.window.length > 1) {
      const [t0, b0] = this.window[0]
      const dt = (now - t0) / 1000
      if (dt > 0) speed = (this.totalBytes - b0) / dt
    }
    const remaining = this.totalSize - this.totalBytes
    const eta = speed > 0 ? Math.ceil(remaining / speed) : null

    this.emitFn({
      fileIndex: file.index,
      fileCount: file.count,
      fileName: file.name,
      fileBytes,
      fileSize: file.size,
      totalBytes: this.totalBytes,
      totalSize: this.totalSize,
      speed,
      eta
    })
  }
}

/* ------------------------------------------------------------------ */
/* Expéditeur                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pilote l'envoi d'une liste de fichiers sur une FrameStream authentifiée.
 * Événements : 'offer-sent', 'accepted', 'rejected', 'progress',
 *              'file-done', 'done', 'error', 'cancelled'.
 */
class TransferSender extends EventEmitter {
  constructor (frames, entries, { senderName }) {
    super()
    this.frames = frames
    // Normalise : on accepte soit des chemins (fichiers seuls), soit des
    // objets { path, relPath } (arborescence d'un dossier). relPath est le
    // chemin affiché/recréé chez le destinataire.
    this.entries = entries.map((e) =>
      typeof e === 'string' ? { path: e, relPath: path.basename(e) } : e)
    this.senderName = senderName
    this.cancelled = false
    this.finished = false
    this._currentStream = null

    // Écouteurs persistants : un CANCEL du pair ou une coupure réseau
    // doivent être traités même en plein streaming de chunks.
    frames.on('json', (msg) => {
      if (msg && msg.t === 'CANCEL') this._onPeerCancel()
    })
    frames.on('error', (err) => this._fail(err))
    frames.on('close', () => {
      this._fail(new Error('La connexion avec le destinataire a été perdue'))
    })
  }

  async start () {
    try {
      await this._run()
    } catch (err) {
      this._fail(err)
    }
  }

  async _run () {
    // Construit l'OFFER. Le SHA-256 n'est pré-calculé que pour les petits
    // envois (peu de fichiers, chacun < 500 Mo) afin de ne pas relire des
    // gigaoctets avant même d'afficher la demande ; sinon le hash est
    // calculé au fil de l'envoi (FILE_END), ce qui reste vérifié.
    const files = []
    const precompute = this.entries.length <= HASH_PRECOMPUTE_MAX_FILES
    for (let i = 0; i < this.entries.length; i++) {
      const { path: p, relPath } = this.entries[i]
      const st = await fsp.stat(p)
      if (!st.isFile()) throw new Error(`« ${path.basename(p)} » n'est pas un fichier`)
      const entry = {
        id: i,
        name: path.basename(relPath),
        relPath,
        size: st.size,
        sha256: null
      }
      if (precompute && st.size < HASH_PRECOMPUTE_LIMIT) entry.sha256 = await hashFile(p)
      files.push(entry)
      if (this.cancelled) return
    }
    const totalSize = files.reduce((a, f) => a + f.size, 0)
    const isFolder = this.entries.some((e) => e.relPath.includes('/') || e.relPath.includes('\\'))

    this.frames.sendJson({ t: 'OFFER', files, sender: this.senderName, folder: isFolder })
    this.emit('offer-sent', { files, totalSize })

    // Le destinataire peut réfléchir, mais pas indéfiniment.
    const reply = await this._waitJson(['ACCEPT', 'REJECT'], ACCEPT_TIMEOUT)
    if (reply.t === 'REJECT') {
      this.finished = true
      this.emit('rejected')
      return
    }
    this.emit('accepted')

    const progress = new ProgressTracker(totalSize, (p) => this.emit('progress', p))

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const meta = { index: i, count: files.length, name: file.name, size: file.size }
      this.frames.sendJson({ t: 'FILE_START', id: file.id })

      const sha256 = await this._streamFile(this.entries[i].path, meta, progress)
      if (this.cancelled || this.finished || this.frames.destroyed) return

      this.frames.sendJson({ t: 'FILE_END', id: file.id, sha256 })
      const ack = await this._waitJson(['FILE_OK', 'FILE_FAIL'], ACK_TIMEOUT)
      if (ack.t === 'FILE_FAIL') {
        throw new Error(`Le fichier « ${file.name} » a été rejeté : ${ack.reason || 'intégrité non vérifiée'}`)
      }
      progress.update(meta, file.size, 0, true)
      this.emit('file-done', { id: file.id, name: file.name })
    }

    this.frames.sendJson({ t: 'DONE' })
    await this._waitJson(['DONE_ACK'], ACK_TIMEOUT)
    this.finished = true
    this.emit('done')
    // L'expéditeur initie la fermeture (il a confirmé la réception du
    // DONE_ACK) : end() propre plutôt qu'un reset qui ferait croire à une
    // erreur côté destinataire encore en train de lire.
    this.frames.endGracefully()
  }

  /** Envoie un fichier par blocs de 64 Ko avec gestion du backpressure. */
  _streamFile (filePath, meta, progress) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      let fileBytes = 0
      const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
      this._currentStream = rs

      rs.on('data', (chunk) => {
        if (this.cancelled || this.frames.destroyed) {
          rs.destroy()
          return resolve(null)
        }
        hash.update(chunk)
        fileBytes += chunk.length
        const ok = this.frames.sendChunk(chunk)
        progress.update(meta, fileBytes, chunk.length)
        if (!ok) {
          // Tampon d'envoi plein : on met le fichier en pause jusqu'au drain.
          rs.pause()
          this.frames.waitDrain().then(() => {
            if (!this.cancelled && !rs.destroyed) rs.resume()
          })
        }
      })
      rs.on('error', reject)
      rs.on('end', () => {
        this._currentStream = null
        resolve(hash.digest('hex'))
      })
    })
  }

  _waitJson (types, timeout = 0) {
    return new Promise((resolve, reject) => {
      const onJson = (msg) => {
        if (msg.t === 'CANCEL') {
          cleanup()
          this._onPeerCancel()
          return reject(new Error('__cancelled__'))
        }
        if (types.includes(msg.t)) {
          cleanup()
          resolve(msg)
        }
        // Les autres messages sont ignorés (tolérance aux évolutions).
      }
      const onError = (err) => { cleanup(); reject(err) }
      const onClose = () => { cleanup(); reject(new Error('La connexion avec le destinataire a été perdue')) }
      const onTimeout = () => { cleanup(); reject(new Error('Le destinataire ne répond plus.')) }
      let timer = null
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.frames.off('json', onJson)
        this.frames.off('error', onError)
        this.frames.off('close', onClose)
      }
      this.frames.on('json', onJson)
      this.frames.on('error', onError)
      this.frames.on('close', onClose)
      if (timeout > 0) timer = setTimeout(onTimeout, timeout)
    })
  }

  _onPeerCancel () {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    if (this._currentStream) this._currentStream.destroy()
    this.emit('cancelled', { by: 'peer' })
    this.frames.destroy()
  }

  cancel () {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    if (this._currentStream) this._currentStream.destroy()
    try { this.frames.sendJson({ t: 'CANCEL' }) } catch {}
    this.emit('cancelled', { by: 'local' })
    // Laisse partir le CANCEL (flush) avant de fermer.
    this.frames.endGracefully()
  }

  _fail (err) {
    if (this.finished || this.cancelled) return
    if (err && err.message === '__cancelled__') return
    this.finished = true
    this.emit('error', err)
    this.frames.destroy()
  }

  /**
   * Arrêt silencieux pour le démantèlement de session (fermeture de l'app).
   * Marque comme terminé AVANT que la socket ne soit détruite, afin que les
   * écouteurs 'close'/'error' n'émettent pas sur un EventEmitter sans listener.
   */
  dispose () {
    this.finished = true
    if (this._currentStream) { try { this._currentStream.destroy() } catch {} }
    this.removeAllListeners()
    this.on('error', () => {}) // puits : aucune 'error' non gérée
  }
}

/* ------------------------------------------------------------------ */
/* Destinataire                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pilote la réception sur une FrameStream authentifiée.
 * L'UI doit appeler accept(destDir) ou reject() après l'événement 'offer'.
 * Événements : 'offer', 'progress', 'file-done', 'done', 'error', 'cancelled'.
 */
class TransferReceiver extends EventEmitter {
  constructor (frames) {
    super()
    this.frames = frames
    this.cancelled = false
    this.finished = false
    this.offer = null
    this.destDir = null
    this._current = null // { file, ws, hash, bytes, partPath, finalPath }
    this._progress = null
    this._results = []
    this._idleTimer = null
    this._rootDirs = new Map() // relPath racine → nom de dossier réservé

    // Les trames sont émises de façon synchrone par la socket alors que
    // certains handlers sont asynchrones (création du .part, rename…) :
    // une file FIFO garantit l'ordre strict json/chunk du protocole.
    this._queue = Promise.resolve()
    const enqueue = (fn) => {
      this._queue = this._queue.then(fn).catch((err) => this._fail(err))
    }
    frames.on('json', (msg) => enqueue(() => this._onJson(msg)))
    frames.on('chunk', (chunk) => enqueue(() => this._onChunk(chunk)))
    frames.on('error', (err) => this._fail(err))
    frames.on('close', () => {
      if (!this.finished && !this.cancelled) {
        this._fail(new Error("La connexion avec l'expéditeur a été perdue"))
      }
    })

    // Un pair authentifié mais muet (jamais d'OFFER) ne doit pas bloquer
    // l'UI : on arme un délai d'attente des détails du transfert.
    this._armIdle(OFFER_TIMEOUT, "L'expéditeur n'a envoyé aucun fichier à temps.")
  }

  _armIdle (ms, message) {
    this._clearIdle()
    this._idleTimer = setTimeout(() => {
      this._fail(new Error(message || 'Le transfert est resté sans activité trop longtemps.'))
    }, ms)
  }

  _clearIdle () {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
  }

  /** Accepte l'offre : seul point où l'écriture disque devient possible. */
  accept (destDir) {
    if (!this.offer || this.destDir) return
    this.destDir = destDir
    const totalSize = this.offer.files.reduce((a, f) => a + f.size, 0)
    this._progress = new ProgressTracker(totalSize, (p) => this.emit('progress', p))
    // Le transfert démarre : on surveille les silences prolongés.
    this._armIdle(IDLE_TIMEOUT, "L'expéditeur ne répond plus.")
    this.frames.sendJson({ t: 'ACCEPT' })
  }

  reject () {
    if (!this.offer || this.destDir) return
    this.finished = true
    this._clearIdle()
    this.frames.sendJson({ t: 'REJECT' })
    this.emit('cancelled', { by: 'local', rejected: true })
    this.frames.endGracefully()
  }

  async _onJson (msg) {
    try {
      switch (msg.t) {
        case 'OFFER': {
          if (this.offer) return
          // Validation stricte de l'offre reçue du réseau.
          if (!Array.isArray(msg.files) || msg.files.length === 0) {
            throw new Error('Offre de transfert invalide')
          }
          const seenIds = new Set()
          const files = msg.files.map((f) => {
            const rel = sanitizeRelPath(f.relPath || f.name) || sanitizeFilename(f.name)
            return {
              id: Number(f.id),
              name: sanitizeFilename(f.name),
              relPath: rel,
              size: Number(f.size),
              sha256: typeof f.sha256 === 'string' ? f.sha256 : null
            }
          })
          for (const f of files) {
            if (!Number.isInteger(f.id) || f.id < 0) throw new Error('Offre de transfert invalide')
            if (seenIds.has(f.id)) throw new Error('Offre de transfert invalide (identifiants dupliqués)')
            seenIds.add(f.id)
            if (!Number.isFinite(f.size) || f.size < 0) throw new Error('Offre de transfert invalide')
          }
          // Plus d'attente d'OFFER : on laisse l'utilisateur confirmer
          // (le minuteur côté expéditeur, ACCEPT_TIMEOUT, prend le relais).
          this._clearIdle()
          this.offer = {
            files,
            sender: String(msg.sender || 'Pair inconnu').slice(0, 64),
            folder: !!msg.folder
          }
          this.emit('offer', this.offer)
          break
        }
        case 'FILE_START':
          await this._startFile(Number(msg.id))
          break
        case 'FILE_END':
          await this._endFile(Number(msg.id), String(msg.sha256 || ''))
          break
        case 'DONE': {
          this.finished = true
          this._clearIdle()
          this.frames.sendJson({ t: 'DONE_ACK' })
          this.emit('done', { files: this._results })
          // On laisse l'expéditeur fermer (il reçoit le DONE_ACK puis envoie
          // un FIN). Filet de sécurité si ce FIN n'arrive jamais.
          setTimeout(() => { try { this.frames.destroy() } catch {} }, 5000).unref?.()
          break
        }
        case 'CANCEL': {
          if (this.finished || this.cancelled) return
          this.cancelled = true
          this._clearIdle()
          await this._cleanupCurrent()
          this.emit('cancelled', { by: 'peer' })
          this.frames.destroy()
          break
        }
      }
    } catch (err) {
      this._fail(err)
    }
  }

  async _startFile (id) {
    if (!this.destDir) throw new Error('Transfert non accepté')
    if (this._current) throw new Error('Protocole invalide : fichier déjà en cours')
    const index = this.offer.files.findIndex((f) => f.id === id)
    if (index === -1) throw new Error('Fichier inconnu dans le protocole')
    const file = this.offer.files[index]

    // Résout un chemin sûr sous destDir, en regroupant les dossiers reçus
    // sous un nom de racine unique mémorisé (pour garder l'arborescence).
    const finalPath = await this._resolveDest(file.relPath)
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })
    const partPath = finalPath + '.part'

    const ws = fs.createWriteStream(partPath, { highWaterMark: CHUNK_SIZE * 4 })
    ws.on('error', (err) => this._fail(err))
    activeParts.set(partPath, ws)
    this._current = {
      file,
      meta: { index, count: this.offer.files.length, name: file.name, size: file.size },
      ws,
      hash: crypto.createHash('sha256'),
      bytes: 0,
      partPath,
      finalPath
    }
  }

  /**
   * Donne un chemin de destination sûr pour une composante relPath reçue.
   * Les fichiers d'un même dossier racine partagent le suffixe d'unicité
   * réservé une seule fois, de sorte que toute l'arborescence reste groupée.
   */
  async _resolveDest (relPath) {
    const segments = relPath.split(path.sep)
    if (segments.length === 1) {
      return uniqueLeaf(this.destDir, relPath)
    }
    const rootKey = segments[0]
    let mapped = this._rootDirs.get(rootKey)
    if (!mapped) {
      mapped = await reserveRootDir(this.destDir, rootKey)
      this._rootDirs.set(rootKey, mapped)
    }
    return path.join(this.destDir, mapped, ...segments.slice(1))
  }

  _onChunk (chunk) {
    if (this.cancelled || this.finished) return
    const cur = this._current
    if (!cur) {
      this._fail(new Error('Protocole invalide : données reçues sans fichier en cours'))
      return
    }
    this._armIdle(IDLE_TIMEOUT, "L'expéditeur ne répond plus.") // activité → on repousse le délai
    if (cur.bytes + chunk.length > cur.file.size) {
      this._fail(new Error("L'expéditeur a envoyé plus de données qu'annoncé"))
      return
    }
    cur.hash.update(chunk)
    cur.bytes += chunk.length
    const ok = cur.ws.write(chunk)
    this._progress.update(cur.meta, cur.bytes, chunk.length)
    if (!ok) {
      // Backpressure côté disque : socket en pause et file bloquée
      // jusqu'à ce que le flux d'écriture se vide.
      this.frames.pause()
      return new Promise((resolve) => {
        const done = () => {
          cur.ws.off('drain', done)
          cur.ws.off('error', done)
          cur.ws.off('close', done)
          if (!this.cancelled && !this.finished) this.frames.resume()
          resolve()
        }
        cur.ws.on('drain', done)
        cur.ws.on('error', done)
        cur.ws.on('close', done)
      })
    }
  }

  async _endFile (id, senderHash) {
    const cur = this._current
    if (!cur || cur.file.id !== id) throw new Error('Protocole invalide : fin de fichier inattendue')
    // NB : on NE vide PAS this._current avant les opérations async ci-dessous.
    // Si ws.end() ou rename() échoue (disque plein, permission), l'exception
    // remonte et _fail() → _cleanupCurrent() doit encore retrouver le .part.

    await new Promise((resolve, reject) => cur.ws.end((err) => err ? reject(err) : resolve()))

    const localHash = cur.hash.digest('hex')
    const sizeOk = cur.bytes === cur.file.size
    const hashOk = senderHash.length === 64 && timingSafeEqualHex(localHash, senderHash)

    if (!sizeOk || !hashOk) {
      // Fichier corrompu : suppression du .part, erreur des deux côtés.
      this._current = null
      await fsp.unlink(cur.partPath).catch(() => {})
      activeParts.delete(cur.partPath)
      this.frames.sendJson({ t: 'FILE_FAIL', id, reason: 'hash SHA-256 invalide' })
      throw new Error(`Le fichier « ${cur.file.name} » est corrompu (vérification d'intégrité échouée). Il a été supprimé.`)
    }

    // Intégrité vérifiée : le .part devient le fichier définitif.
    await fsp.rename(cur.partPath, cur.finalPath)
    this._current = null
    activeParts.delete(cur.partPath)
    this._results.push({ id, name: cur.file.name, relPath: cur.file.relPath, path: cur.finalPath, size: cur.file.size })
    this.frames.sendJson({ t: 'FILE_OK', id })
    this._progress.update(cur.meta, cur.file.size, 0, true)
    this.emit('file-done', { id, name: cur.file.name, path: cur.finalPath })
  }

  async _cleanupCurrent () {
    const cur = this._current
    this._current = null
    if (!cur) return
    // Attendre la fermeture effective du flux avant l'unlink : sous Windows
    // un unlink sur un fichier encore ouvert échoue.
    await new Promise((resolve) => {
      if (cur.ws.closed) return resolve()
      cur.ws.once('close', resolve)
      try { cur.ws.destroy() } catch { resolve() }
    })
    await fsp.unlink(cur.partPath).catch(() => {})
    activeParts.delete(cur.partPath)
  }

  cancel () {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    this._clearIdle()
    try { this.frames.sendJson({ t: 'CANCEL' }) } catch {}
    this._cleanupCurrent().finally(() => {
      this.emit('cancelled', { by: 'local' })
      this.frames.endGracefully()
    })
  }

  _fail (err) {
    if (this.finished || this.cancelled) return
    this.finished = true
    this._clearIdle()
    this._cleanupCurrent().finally(() => {
      this.emit('error', err)
      this.frames.destroy()
    })
  }

  /**
   * Arrêt silencieux pour le démantèlement de session (fermeture de l'app).
   * Marque comme terminé et nettoie le .part en cours sans émettre d'erreur.
   */
  dispose () {
    this.finished = true
    this._clearIdle()
    this.removeAllListeners()
    this.on('error', () => {})
    return this._cleanupCurrent()
  }
}

/** Comparaison à temps constant de deux hash hexadécimaux. */
function timingSafeEqualHex (a, b) {
  const ba = b4a.from(a, 'hex')
  const bb = b4a.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

module.exports = {
  FrameStream,
  TransferSender,
  TransferReceiver,
  sanitizeFilename,
  sanitizeRelPath,
  uniquePath,
  hashFile,
  cleanupAllPartFiles,
  CHUNK_SIZE
}
