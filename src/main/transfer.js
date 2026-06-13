'use strict'

// Transfer protocol over an authenticated, Noise-encrypted socket.
// Length-prefixed framing: [u32 length][u8 type][payload]
//   type 0 = JSON control message, type 1 = binary file chunk.
// Files are streamed into "<name>.part" and renamed once the SHA-256 checks out.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { EventEmitter } = require('events')
const b4a = require('b4a')

const CHUNK_SIZE = 64 * 1024
const MAX_JSON_FRAME = 4 * 1024 * 1024
const MAX_CHUNK_FRAME = CHUNK_SIZE + 1024
const HASH_PRECOMPUTE_LIMIT = 500 * 1024 * 1024
const HASH_PRECOMPUTE_MAX_FILES = 20
const PROGRESS_INTERVAL = 200

// On-the-fly transport compression for text-like formats above a floor size.
// Already-compressed formats (zip, jpg, mp4...) are sent as-is. The SHA-256
// always covers the original bytes, so compression never weakens integrity.
const COMPRESS_MIN_SIZE = 4 * 1024
const COMPRESSIBLE_EXT = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css',
  '.js', '.mjs', '.ts', '.md', '.rtf', '.svg', '.yml', '.yaml', '.ini',
  '.bmp', '.tiff', '.tif', '.wav', '.tar', '.sql', '.c', '.h', '.cpp',
  '.py', '.java', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.tex'
])

function shouldCompress (name, size) {
  if (size < COMPRESS_MIN_SIZE) return false
  return COMPRESSIBLE_EXT.has(path.extname(String(name)).toLowerCase())
}

function makeCompressor () {
  return zlib.createBrotliCompress({
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 22
    }
  })
}

function makeDecompressor () {
  return zlib.createBrotliDecompress()
}

const FRAME_JSON = 0
const FRAME_CHUNK = 1

// Open ".part" write streams (path -> stream) so we can close then delete them
// if the app quits mid-transfer (on Windows, unlink fails while a file is open).
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

// Protocol timeouts so an authenticated but silent peer never hangs the UI.
const OFFER_TIMEOUT = 30 * 1000
const ACCEPT_TIMEOUT = 5 * 60 * 1000
const ACK_TIMEOUT = 60 * 1000
const IDLE_TIMEOUT = 60 * 1000

// Wraps a duplex socket into a stream of typed frames.
// Emits: 'json', 'chunk' (Buffer), 'error', 'close'.
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
    while (this._buffer.length >= 4) {
      const len = readUInt32BE(this._buffer, 0)
      if (len < 1 || len > MAX_JSON_FRAME + 1) {
        this._fail(new Error('Invalid frame from peer'))
        return
      }
      if (this._buffer.length < 4 + len) break
      const type = this._buffer[4]
      const payload = this._buffer.subarray(5, 4 + len)
      this._buffer = b4a.from(this._buffer.subarray(4 + len))
      if (type === FRAME_JSON) {
        if (len > MAX_JSON_FRAME) {
          this._fail(new Error('Control message too large'))
          return
        }
        let msg
        try {
          msg = JSON.parse(b4a.toString(payload, 'utf8'))
        } catch {
          this._fail(new Error('Unreadable control message'))
          return
        }
        this.emit('json', msg)
      } else if (type === FRAME_CHUNK) {
        if (len > MAX_CHUNK_FRAME) {
          this._fail(new Error('Data block too large'))
          return
        }
        this.emit('chunk', b4a.from(payload))
      } else {
        this._fail(new Error('Unknown frame type'))
        return
      }
    }
  }

  sendJson (obj) {
    return this._write(FRAME_JSON, b4a.from(JSON.stringify(obj), 'utf8'))
  }

  sendChunk (buf) {
    return this._write(FRAME_CHUNK, buf)
  }

  _write (type, payload) {
    if (this._destroyed) return false
    const frame = b4a.alloc(5 + payload.length)
    writeUInt32BE(frame, payload.length + 1, 0)
    frame[4] = type
    frame.set(payload, 5)
    return this.socket.write(frame)
  }

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

  // Flush queued bytes (e.g. a CANCEL/REJECT) then destroy.
  endGracefully () {
    if (this._destroyed) return
    this._destroyed = true
    try {
      this.socket.end(() => { try { this.socket.destroy() } catch {} })
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

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

// Keeps only the base name (no path, so no "../"), strips Windows-forbidden
// characters and reserved names.
function sanitizeFilename (name) {
  let s = String(name)
  s = s.split(/[/\\]/).pop() || ''
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  s = s.replace(/[. ]+$/g, '')
  if (s === '' || s === '.' || s === '..') s = 'file'
  const base = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s
  if (WINDOWS_RESERVED.test(base)) s = '_' + s
  if (s.length > 200) {
    const ext = s.includes('.') ? s.slice(s.lastIndexOf('.')) : ''
    s = s.slice(0, 200 - ext.length) + ext
  }
  return s
}

// Sanitizes each component of a received relative path; the result can never
// escape the destination folder. Returns null if everything is empty.
function sanitizeRelPath (relPath) {
  const parts = String(relPath)
    .split(/[/\\]/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .map((p) => sanitizeFilename(p))
  if (parts.length === 0) return null
  return parts.join(path.sep)
}

// For a lone file, suffixes "(1)" on the name. For a file inside a received
// folder, only the root folder is suffixed once, keeping the tree together.
async function uniquePath (destDir, relPath) {
  const segments = relPath.split(path.sep)
  if (segments.length === 1) {
    return uniqueLeaf(destDir, relPath)
  }
  const root = await reserveRootDir(destDir, segments[0])
  return path.join(destDir, root, ...segments.slice(1))
}

async function reserveRootDir (destDir, name) {
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${name} (${i})`
    if (!await pathExists(path.join(destDir, candidate))) return candidate
  }
  throw new Error('Could not find a free folder name')
}

async function uniqueLeaf (dir, name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = ext ? name.slice(0, name.length - ext.length) : name
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`
    const full = path.join(dir, candidate)
    const taken = await pathExists(full) || await pathExists(full + '.part')
    if (!taken) return full
  }
  throw new Error('Could not find a free file name')
}

async function pathExists (p) {
  try { await fsp.access(p); return true } catch { return false }
}

// Moves a file, falling back to copy+unlink across volumes (EXDEV).
async function moveFile (src, dst) {
  try {
    await fsp.rename(src, dst)
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.copyFile(src, dst)
      await fsp.unlink(src).catch(() => {})
    } else {
      throw err
    }
  }
}

function hashFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    rs.on('data', (d) => hash.update(d))
    rs.on('error', reject)
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

// Feeds a hash with the first "upTo" bytes of a file (used when resuming).
function seedHash (hash, filePath, upTo) {
  return new Promise((resolve, reject) => {
    if (upTo <= 0) return resolve()
    const rs = fs.createReadStream(filePath, { start: 0, end: upTo - 1, highWaterMark: CHUNK_SIZE })
    rs.on('data', (d) => hash.update(d))
    rs.on('error', reject)
    rs.on('end', resolve)
  })
}

class ProgressTracker {
  constructor (totalSize, emit) {
    this.totalSize = totalSize
    this.totalBytes = 0
    this.emitFn = emit
    this.lastEmit = 0
    this.window = []
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

// Drives sending a list of files over an authenticated FrameStream.
// Events: 'offer-sent', 'accepted', 'rejected', 'progress', 'file-done',
//         'done', 'error', 'cancelled'.
class TransferSender extends EventEmitter {
  constructor (frames, entries, { senderName, compression = true, rateLimit = 0 } = {}) {
    super()
    this.frames = frames
    this.entries = entries.map((e) =>
      typeof e === 'string' ? { path: e, relPath: path.basename(e) } : e)
    this.senderName = senderName
    this.compression = compression
    this.rateLimit = rateLimit | 0
    this.cancelled = false
    this.finished = false
    this._currentStream = null
    this._ackedOk = 0
    this._fileMeta = new Map()
    this._sentAt = 0

    // Sending is pipelined: we no longer wait for each FILE_OK before sending
    // the next file. Acks are collected here, and a FILE_FAIL aborts at once.
    frames.on('json', (msg) => {
      if (!msg) return
      if (msg.t === 'CANCEL') this._onPeerCancel()
      else if (msg.t === 'FILE_FAIL') this._onFileFail(msg)
      else if (msg.t === 'FILE_OK') this._onFileOk(msg)
    })
    frames.on('error', (err) => this._fail(err))
    frames.on('close', () => {
      this._fail(new Error('The connection to the recipient was lost'))
    })
  }

  _onFileOk (msg) {
    if (this.finished || this.cancelled) return
    this._ackedOk++
    const m = this._fileMeta.get(Number(msg.id))
    if (m) this.emit('file-done', { id: Number(msg.id), name: m.name })
  }

  _onFileFail (msg) {
    if (this.finished || this.cancelled) return
    const name = (this._fileMeta.get(Number(msg.id)) || {}).name || 'a file'
    this._fail(new Error(`File "${name}" was rejected: ${msg.reason || 'integrity not verified'}`))
  }

  async start () {
    try {
      await this._run()
    } catch (err) {
      this._fail(err)
    }
  }

  async _run () {
    // SHA-256 is precomputed only for small offers (few files, each < 500 MB)
    // so we do not reread gigabytes before even showing the request; otherwise
    // it is computed while sending (FILE_END), still verified.
    const files = []
    const precompute = this.entries.length <= HASH_PRECOMPUTE_MAX_FILES
    for (let i = 0; i < this.entries.length; i++) {
      const { path: p, relPath, thumb } = this.entries[i]
      const st = await fsp.stat(p)
      if (!st.isFile()) throw new Error(`"${path.basename(p)}" is not a file`)
      const entry = {
        id: i,
        name: path.basename(relPath),
        relPath,
        size: st.size,
        sha256: null
      }
      if (typeof thumb === 'string' && thumb.startsWith('data:image/') && thumb.length < 200000) {
        entry.thumb = thumb
      }
      if (precompute && st.size < HASH_PRECOMPUTE_LIMIT) entry.sha256 = await hashFile(p)
      files.push(entry)
      if (this.cancelled) return
    }
    const totalSize = files.reduce((a, f) => a + f.size, 0)
    const isFolder = this.entries.some((e) => e.relPath.includes('/') || e.relPath.includes('\\'))

    this.frames.sendJson({
      t: 'OFFER', files, sender: this.senderName, folder: isFolder, compression: this.compression
    })
    this.emit('offer-sent', { files, totalSize })

    const reply = await this._waitJson(['ACCEPT', 'REJECT'], ACCEPT_TIMEOUT)
    if (reply.t === 'REJECT') {
      this.finished = true
      this.emit('rejected')
      return
    }
    this.emit('accepted')

    // Resume: the recipient may report bytes already received per relPath. We
    // resume from that offset; the SHA-256 still covers the whole file.
    const resume = (reply && reply.resume && typeof reply.resume === 'object') ? reply.resume : {}
    const progress = new ProgressTracker(totalSize, (p) => this.emit('progress', p))
    this._sentAt = Date.now()

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const meta = { index: i, count: files.length, name: file.name, size: file.size }
      this._fileMeta.set(file.id, { name: file.name })

      let startOffset = Number(resume[file.relPath] || resume[file.name] || 0)
      if (!Number.isFinite(startOffset) || startOffset < 0 || startOffset > file.size) startOffset = 0
      const compress = this.compression && shouldCompress(file.name, file.size - startOffset)

      this.frames.sendJson({ t: 'FILE_START', id: file.id, compressed: compress, offset: startOffset })
      if (startOffset > 0) progress.update(meta, startOffset, startOffset)

      const sha256 = await this._streamFile(this.entries[i].path, meta, progress, { compress, startOffset })
      if (this.cancelled || this.finished || this.frames.destroyed) return

      this.frames.sendJson({ t: 'FILE_END', id: file.id, sha256 })
    }

    this.frames.sendJson({ t: 'DONE' })
    await this._waitJson(['DONE_ACK'], ACK_TIMEOUT)
    this.finished = true
    this.emit('done')
    this.frames.endGracefully()
  }

  async _streamFile (filePath, meta, progress, { compress = false, startOffset = 0 } = {}) {
    const hash = crypto.createHash('sha256')
    if (startOffset > 0) await seedHash(hash, filePath, startOffset)
    return compress
      ? this._streamCompressed(filePath, meta, progress, hash, startOffset)
      : this._streamRaw(filePath, meta, progress, hash, startOffset)
  }

  _streamRaw (filePath, meta, progress, hash, startOffset) {
    return new Promise((resolve, reject) => {
      let fileBytes = startOffset
      const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE, start: startOffset })
      this._currentStream = rs
      rs.on('data', (chunk) => {
        if (this.cancelled || this.frames.destroyed) { rs.destroy(); return resolve(null) }
        hash.update(chunk)
        fileBytes += chunk.length
        const ok = this.frames.sendChunk(chunk)
        progress.update(meta, fileBytes, chunk.length)
        if (!ok || this._overRate(fileBytes - startOffset)) {
          rs.pause()
          this._throttle(fileBytes - startOffset).then(() => this.frames.waitDrain()).then(() => {
            if (!this.cancelled && !rs.destroyed) rs.resume()
          })
        }
      })
      rs.on('error', reject)
      rs.on('end', () => { this._currentStream = null; resolve(hash.digest('hex')) })
    })
  }

  _streamCompressed (filePath, meta, progress, hash, startOffset) {
    return new Promise((resolve, reject) => {
      let fileBytes = startOffset
      const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE, start: startOffset })
      const comp = makeCompressor()
      this._currentStream = rs
      const fail = (err) => { try { rs.destroy() } catch {}; try { comp.destroy() } catch {}; reject(err) }

      rs.on('data', (chunk) => {
        if (this.cancelled || this.frames.destroyed) { rs.destroy(); comp.destroy(); return resolve(null) }
        hash.update(chunk)
        fileBytes += chunk.length
        progress.update(meta, fileBytes, chunk.length)
        if (!comp.write(chunk)) rs.pause()
      })
      comp.on('drain', () => { if (!rs.destroyed && !this.cancelled) rs.resume() })
      rs.on('error', fail)
      rs.on('end', () => comp.end())

      comp.on('data', (cbuf) => {
        if (this.cancelled || this.frames.destroyed) return
        for (let off = 0; off < cbuf.length; off += CHUNK_SIZE) {
          const ok = this.frames.sendChunk(cbuf.subarray(off, Math.min(off + CHUNK_SIZE, cbuf.length)))
          if (!ok) {
            comp.pause()
            this.frames.waitDrain().then(() => { if (!this.cancelled) comp.resume() })
            break
          }
        }
      })
      comp.on('error', fail)
      comp.on('end', () => { this._currentStream = null; resolve(hash.digest('hex')) })
    })
  }

  _overRate (sent) {
    if (!this.rateLimit) return false
    const elapsed = (Date.now() - this._sentAt) / 1000
    return sent > this.rateLimit * Math.max(elapsed, 0.001)
  }

  _throttle (sent) {
    if (!this.rateLimit) return Promise.resolve()
    const target = sent / this.rateLimit
    const elapsed = (Date.now() - this._sentAt) / 1000
    const wait = Math.min(2000, Math.max(0, (target - elapsed) * 1000))
    return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve()
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
      }
      const onError = (err) => { cleanup(); reject(err) }
      const onClose = () => { cleanup(); reject(new Error('The connection to the recipient was lost')) }
      const onTimeout = () => { cleanup(); reject(new Error('The recipient is not responding.')) }
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
    this.frames.endGracefully()
  }

  _fail (err) {
    if (this.finished || this.cancelled) return
    if (err && err.message === '__cancelled__') return
    this.finished = true
    this.emit('error', err)
    this.frames.destroy()
  }

  // Silent teardown when the app closes: mark finished before the socket is
  // destroyed so 'close'/'error' don't emit on a listener-less emitter.
  dispose () {
    this.finished = true
    if (this._currentStream) { try { this._currentStream.destroy() } catch {} }
    this.removeAllListeners()
    this.on('error', () => {})
  }
}

// Drives receiving over an authenticated FrameStream. The UI must call
// accept(destDir) or reject() after the 'offer' event.
// Events: 'offer', 'progress', 'file-done', 'done', 'error', 'cancelled'.
class TransferReceiver extends EventEmitter {
  constructor (frames, { resumeDir = null } = {}) {
    super()
    this.frames = frames
    // When set, an interrupted .part is kept here (keyed by relPath+size) so a
    // later attempt with the same code can resume. null = no resume.
    this.resumeDir = resumeDir
    this.cancelled = false
    this.finished = false
    this.offer = null
    this.destDir = null
    this._current = null
    this._progress = null
    this._results = []
    this._idleTimer = null
    this._resumeOffsets = new Map()
    this._rootDirs = new Map()

    // Frames arrive synchronously while some handlers are async (.part create,
    // rename...): a FIFO queue keeps the strict json/chunk protocol order.
    this._queue = Promise.resolve()
    const enqueue = (fn) => {
      this._queue = this._queue.then(fn).catch((err) => this._fail(err))
    }
    frames.on('json', (msg) => enqueue(() => this._onJson(msg)))
    frames.on('chunk', (chunk) => enqueue(() => this._onChunk(chunk)))
    frames.on('error', (err) => this._fail(err))
    frames.on('close', () => {
      if (!this.finished && !this.cancelled) {
        this._fail(new Error('The connection to the sender was lost'))
      }
    })

    this._armIdle(OFFER_TIMEOUT, 'The sender did not send any file in time.')
  }

  _armIdle (ms, message) {
    this._clearIdle()
    this._idleTimer = setTimeout(() => {
      this._fail(new Error(message || 'The transfer was idle for too long.'))
    }, ms)
  }

  _clearIdle () {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
  }

  async accept (destDir) {
    if (!this.offer || this.destDir) return
    this.destDir = destDir
    const totalSize = this.offer.files.reduce((a, f) => a + f.size, 0)
    this._progress = new ProgressTracker(totalSize, (p) => this.emit('progress', p))

    const resume = {}
    if (this.resumeDir) {
      for (const f of this.offer.files) {
        const have = await this._partialBytes(f).catch(() => 0)
        if (have > 0 && have <= f.size) {
          this._resumeOffsets.set(f.id, have)
          resume[f.relPath] = have
        }
      }
    }

    this._armIdle(IDLE_TIMEOUT, 'The sender is not responding.')
    this.frames.sendJson({ t: 'ACCEPT', resume })
  }

  _partialPath (file) {
    const key = crypto.createHash('sha256')
      .update(`${file.relPath}|${file.size}`).digest('hex').slice(0, 32)
    return path.join(this.resumeDir, key + '.part')
  }

  async _partialBytes (file) {
    const st = await fsp.stat(this._partialPath(file)).catch(() => null)
    return st && st.isFile() ? st.size : 0
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
    // After a failure/cancel, ignore leftover frames: with pipelined sending a
    // DONE may follow a FILE_FAIL on the wire.
    if (this.finished || this.cancelled) return
    try {
      switch (msg.t) {
        case 'OFFER': {
          if (this.offer) return
          if (!Array.isArray(msg.files) || msg.files.length === 0) {
            throw new Error('Invalid transfer offer')
          }
          const seenIds = new Set()
          const files = msg.files.map((f) => {
            const rel = sanitizeRelPath(f.relPath || f.name) || sanitizeFilename(f.name)
            const thumb = (typeof f.thumb === 'string' &&
              f.thumb.startsWith('data:image/') && f.thumb.length < 200000) ? f.thumb : null
            return {
              id: Number(f.id),
              name: sanitizeFilename(f.name),
              relPath: rel,
              size: Number(f.size),
              sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
              thumb
            }
          })
          for (const f of files) {
            if (!Number.isInteger(f.id) || f.id < 0) throw new Error('Invalid transfer offer')
            if (seenIds.has(f.id)) throw new Error('Invalid transfer offer (duplicate ids)')
            seenIds.add(f.id)
            if (!Number.isFinite(f.size) || f.size < 0) throw new Error('Invalid transfer offer')
          }
          this._clearIdle()
          this.offer = {
            files,
            sender: String(msg.sender || 'Unknown peer').slice(0, 64),
            folder: !!msg.folder,
            compression: !!msg.compression
          }
          this.emit('offer', this.offer)
          break
        }
        case 'FILE_START':
          await this._startFile(Number(msg.id), {
            compressed: !!msg.compressed,
            offset: Number(msg.offset) || 0
          })
          break
        case 'FILE_END':
          await this._endFile(Number(msg.id), String(msg.sha256 || ''))
          break
        case 'DONE': {
          this.finished = true
          this._clearIdle()
          this.frames.sendJson({ t: 'DONE_ACK' })
          this.emit('done', { files: this._results })
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

  async _startFile (id, { compressed = false, offset = 0 } = {}) {
    if (!this.destDir) throw new Error('Transfer not accepted')
    if (this._current) throw new Error('Invalid protocol: file already in progress')
    const index = this.offer.files.findIndex((f) => f.id === id)
    if (index === -1) throw new Error('Unknown file in protocol')
    const file = this.offer.files[index]

    const finalPath = await this._resolveDest(file.relPath)
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })

    const partPath = this.resumeDir ? this._partialPath(file) : finalPath + '.part'
    if (this.resumeDir) await fsp.mkdir(this.resumeDir, { recursive: true })

    const hash = crypto.createHash('sha256')
    let bytes = 0
    const wsOpts = { highWaterMark: CHUNK_SIZE * 4 }
    if (offset > 0 && this._resumeOffsets.get(id) === offset && (await this._partialBytes(file)) >= offset) {
      await seedHash(hash, partPath, offset)
      bytes = offset
      wsOpts.flags = 'r+'
      wsOpts.start = offset
    }

    const ws = fs.createWriteStream(partPath, wsOpts)
    ws.on('error', (err) => this._fail(err))
    activeParts.set(partPath, ws)

    const cur = {
      file,
      meta: { index, count: this.offer.files.length, name: file.name, size: file.size },
      ws,
      hash,
      bytes,
      partPath,
      finalPath,
      decomp: null
    }
    if (compressed) cur.decomp = this._makeDecompPipeline(cur)
    this._current = cur
  }

  // Decompressor for a compressed file: its output (original bytes) feeds the
  // hash, counter and disk write, with backpressure on the disk.
  _makeDecompPipeline (cur) {
    const decomp = makeDecompressor()
    decomp.on('data', (out) => {
      if (this.cancelled || this.finished) return
      if (cur.bytes + out.length > cur.file.size) {
        this._fail(new Error('The sender sent more data than announced'))
        return
      }
      cur.hash.update(out)
      cur.bytes += out.length
      this._progress.update(cur.meta, cur.bytes, out.length)
      if (!cur.ws.write(out)) {
        decomp.pause()
        const resume = () => {
          cur.ws.off('drain', resume)
          if (!this.cancelled && !this.finished) decomp.resume()
        }
        cur.ws.on('drain', resume)
      }
    })
    decomp.on('error', (err) => this._fail(err))
    return decomp
  }

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
      this._fail(new Error('Invalid protocol: data received with no current file'))
      return
    }
    this._armIdle(IDLE_TIMEOUT, 'The sender is not responding.')

    if (cur.decomp) {
      const ok = cur.decomp.write(chunk)
      if (!ok) {
        this.frames.pause()
        return new Promise((resolve) => {
          const done = () => {
            cur.decomp.off('drain', done)
            if (!this.cancelled && !this.finished) this.frames.resume()
            resolve()
          }
          cur.decomp.on('drain', done)
        })
      }
      return
    }

    if (cur.bytes + chunk.length > cur.file.size) {
      this._fail(new Error('The sender sent more data than announced'))
      return
    }
    cur.hash.update(chunk)
    cur.bytes += chunk.length
    const ok = cur.ws.write(chunk)
    this._progress.update(cur.meta, cur.bytes, chunk.length)
    if (!ok) {
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
    if (!cur || cur.file.id !== id) throw new Error('Invalid protocol: unexpected end of file')

    if (cur.decomp) {
      await new Promise((resolve, reject) => {
        cur.decomp.on('error', reject)
        cur.decomp.on('end', resolve)
        cur.decomp.end()
      })
    }

    await new Promise((resolve, reject) => cur.ws.end((err) => err ? reject(err) : resolve()))

    const localHash = cur.hash.digest('hex')
    const sizeOk = cur.bytes === cur.file.size
    const hashOk = senderHash.length === 64 && timingSafeEqualHex(localHash, senderHash)

    if (!sizeOk || !hashOk) {
      this._current = null
      await fsp.unlink(cur.partPath).catch(() => {})
      activeParts.delete(cur.partPath)
      this.frames.sendJson({ t: 'FILE_FAIL', id, reason: 'invalid SHA-256 hash' })
      throw new Error(`File "${cur.file.name}" is corrupted (integrity check failed). It was deleted.`)
    }

    await moveFile(cur.partPath, cur.finalPath)
    this._current = null
    activeParts.delete(cur.partPath)
    this._results.push({ id, name: cur.file.name, relPath: cur.file.relPath, path: cur.finalPath, size: cur.file.size })
    this.frames.sendJson({ t: 'FILE_OK', id })
    this._progress.update(cur.meta, cur.file.size, 0, true)
    this.emit('file-done', { id, name: cur.file.name, path: cur.finalPath })
  }

  async _cleanupCurrent (keepPartial = false) {
    const cur = this._current
    this._current = null
    if (!cur) return
    if (cur.decomp) { try { cur.decomp.destroy() } catch {} }
    await new Promise((resolve) => {
      if (cur.ws.closed) return resolve()
      cur.ws.once('close', resolve)
      try { cur.ws.destroy() } catch { resolve() }
    })
    activeParts.delete(cur.partPath)
    // On a network drop (not an explicit cancel) we keep the partial to resume.
    if (keepPartial && this.resumeDir) return
    await fsp.unlink(cur.partPath).catch(() => {})
  }

  cancel () {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    this._clearIdle()
    try { this.frames.sendJson({ t: 'CANCEL' }) } catch {}
    this._cleanupCurrent(false).finally(() => {
      this.emit('cancelled', { by: 'local' })
      this.frames.endGracefully()
    })
  }

  _fail (err) {
    if (this.finished || this.cancelled) return
    this.finished = true
    this._clearIdle()
    this._cleanupCurrent(true).finally(() => {
      this.emit('error', err)
      this.frames.destroy()
    })
  }

  dispose () {
    this.finished = true
    this._clearIdle()
    this.removeAllListeners()
    this.on('error', () => {})
    return this._cleanupCurrent(true)
  }
}

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
  shouldCompress,
  CHUNK_SIZE
}
