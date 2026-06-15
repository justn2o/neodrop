'use strict'

// Peer discovery over the public Hyperswarm DHT (and mDNS on a LAN) plus a
// mutual challenge-response that proves both sides know the code without ever
// sending it:
//
//   A -> B : HELLO { nonce_A, role_A }
//   B -> A : HELLO { nonce_B, role_B }
//   A -> B : AUTH  { mac = HMAC-SHA256(authKey, cb || nonce_B || role_A) }
//   B -> A : AUTH  { mac = HMAC-SHA256(authKey, cb || nonce_A || role_B) }
//
// The role is in the MAC to block a reflection attack. "cb" is a channel
// binding: the Noise handshakeHash, identical on both ends of one connection
// but different on each leg of a relay, so a man-in-the-middle cannot just
// forward the proofs. Sender invalidates the code after 3 failed attempts.

const crypto = require('crypto')
const { EventEmitter } = require('events')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const { deriveSecrets } = require('./code')
const { FrameStream } = require('./transfer')

const CODE_TTL_MS = 15 * 60 * 1000
const JOIN_TIMEOUT_MS = 30 * 1000
const AUTH_TIMEOUT_MS = 15 * 1000
const MAX_AUTH_FAILURES = 3
// Window to gather concurrent authenticated connections (LAN + DHT) before
// deterministically keeping the same one on both sides.
const SELECT_WINDOW_MS = 400

// The Noise handshakeHash, identical on both ends of one connection. Empty if
// the socket doesn't expose one (bare TCP in tests) — both ends then use the
// same empty value, which stays consistent.
function channelBinding (frames) {
  const s = frames && frames.socket
  const hh = s && (s.handshakeHash || (s.rawStream && s.rawStream.handshakeHash))
  return b4a.isBuffer(hh) ? hh : b4a.alloc(0)
}

function authenticate (frames, { authKey, role, timeout = AUTH_TIMEOUT_MS }) {
  const myNonce = crypto.randomBytes(16)
  const peerRole = role === 'sender' ? 'receiver' : 'sender'

  return new Promise((resolve) => {
    let peerNonce = null
    let peerProofOk = false
    let authOkReceived = false
    let settled = false

    const timer = setTimeout(() => settle(false), timeout)
    const onError = () => settle(false)
    const onClose = () => settle(false)
    const settle = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      frames.off('json', onJson)
      frames.off('error', onError)
      frames.off('close', onClose)
      resolve(ok)
    }

    const onJson = (msg) => {
      try {
        const cb = channelBinding(frames)
        if (msg.t === 'HELLO') {
          if (peerNonce || msg.role !== peerRole) return settle(false)
          peerNonce = b4a.from(String(msg.nonce), 'hex')
          if (peerNonce.length !== 16) return settle(false)
          const mac = crypto.createHmac('sha256', authKey)
            .update(cb).update(peerNonce).update(role).digest('hex')
          frames.sendJson({ t: 'AUTH', mac })
        } else if (msg.t === 'AUTH') {
          if (!peerNonce || peerProofOk) return settle(false)
          const expected = crypto.createHmac('sha256', authKey)
            .update(cb).update(myNonce).update(peerRole).digest()
          const received = b4a.from(String(msg.mac), 'hex')
          if (received.length !== expected.length ||
              !crypto.timingSafeEqual(received, expected)) {
            return settle(false)
          }
          peerProofOk = true
          frames.sendJson({ t: 'AUTH_OK' })
          if (authOkReceived) settle(true)
        } else if (msg.t === 'AUTH_OK') {
          authOkReceived = true
          if (peerProofOk) settle(true)
        } else {
          settle(false)
        }
      } catch {
        settle(false)
      }
    }

    frames.on('json', onJson)
    frames.on('error', onError)
    frames.on('close', onClose)
    frames.sendJson({ t: 'HELLO', nonce: myNonce.toString('hex'), role })
  })
}

// Joins the topic, authenticates the first valid peer and exposes a ready
// FrameStream. Events: 'peer-connected', 'peer-authenticated', 'auth-failed',
// 'invalidated', 'expired', 'timeout', 'error'.
class SwarmSession extends EventEmitter {
  constructor ({ code, role, swarmOpts = null, passphrase = '', lan = true }) {
    super()
    this.code = code
    this.role = role
    this.passphrase = passphrase
    this.swarmOpts = swarmOpts
    this.lan = lan
    this.swarm = null
    this.authKey = null
    this.frames = null
    this.closed = false
    this.authFailures = 0
    this._discovery = null
    this._lan = null
    this._timers = []
    this._pendingSockets = new Set()
    this._candidates = []
    this._selectTimer = null
    this._selected = false
  }

  async start () {
    const { topic, authKey } = await deriveSecrets(this.code, this.passphrase)
    if (this.closed) return
    this.authKey = authKey

    this.swarm = new Hyperswarm(this.swarmOpts || {})
    this.swarm.on('connection', (socket, info) => this._onConnection(socket, info))

    // Both sides announce AND look up, so the connection forms either way.
    this._discovery = this.swarm.join(topic, { server: true, client: true })
    this._discovery.flushed().catch(() => {})

    // LAN (mDNS) discovery in parallel; best-effort, DHT takes over on failure.
    if (this.lan && !this.swarmOpts) {
      try {
        const { LanDiscovery } = require('./lan')
        this._lan = new LanDiscovery(topic)
        this._lan.on('connection', (socket, info) => this._onConnection(socket, info))
        this._lan.start()
      } catch { this._lan = null }
    }

    if (this.role === 'sender') {
      this._addTimer(setTimeout(() => {
        if (!this.frames) {
          this.emit('expired')
          this.close()
        }
      }, CODE_TTL_MS))
    } else {
      this._addTimer(setTimeout(() => {
        if (!this.frames) {
          this.emit('timeout')
          this.close()
        }
      }, JOIN_TIMEOUT_MS))
    }
  }

  _onConnection (socket, info) {
    if (this.closed || this._selected) {
      socket.destroy()
      return
    }
    this._pendingSockets.add(socket)
    socket.on('close', () => this._pendingSockets.delete(socket))
    socket.on('error', () => {})
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(5000)

    this.emit('peer-connected')
    this._authenticate(socket, info).catch(() => {
      try { socket.destroy() } catch {}
    })
  }

  async _authenticate (socket, info) {
    const frames = new FrameStream(socket)
    const result = await authenticate(frames, { authKey: this.authKey, role: this.role })

    if (this.closed) {
      frames.destroy()
      return
    }

    if (!result) {
      frames.destroy()
      this.authFailures++
      this.emit('auth-failed', {
        failures: this.authFailures,
        remaining: MAX_AUTH_FAILURES - this.authFailures
      })
      if (this.role === 'sender' && this.authFailures >= MAX_AUTH_FAILURES) {
        this.emit('invalidated')
        this.close()
      }
      return
    }

    if (this._selected) {
      frames.destroy()
      return
    }
    this._addCandidate(frames, socket, info)
  }

  // Several channels can authenticate at once between the SAME two peers (DHT
  // plus up to two crossed LAN connections). Keeping "first one wins" lets each
  // side keep a DIFFERENT connection and cut the other (both see a lost
  // connection). So we collect candidates briefly, then keep one
  // deterministically: the Noise handshakeHash is identical on both ends of a
  // connection, so min(handshakeHash) picks the same one for both peers.
  _addCandidate (frames, socket, info) {
    if (this.closed) { frames.destroy(); return }
    this._candidates.push({ frames, socket, info, hh: channelBinding(frames) })
    frames.on('close', () => this._dropCandidate(frames))
    if (!this._selectTimer) {
      this._selectTimer = setTimeout(() => this._select(), SELECT_WINDOW_MS)
    }
  }

  _dropCandidate (frames) {
    const i = this._candidates.findIndex((c) => c.frames === frames)
    if (i !== -1) this._candidates.splice(i, 1)
  }

  _select () {
    this._selectTimer = null
    if (this.closed || this._selected) return
    const alive = this._candidates.filter((c) => !c.frames.destroyed)
    if (alive.length === 0) return
    alive.sort((a, b) => b4a.compare(a.hh, b.hh))
    const chosen = alive[0]
    this._selected = true
    this._candidates = []
    for (const c of alive) if (c.frames !== chosen.frames) c.frames.destroy()
    this.frames = chosen.frames
    this._clearTimers()
    this.emit('peer-authenticated', {
      frames: chosen.frames,
      connectionType: describeConnection(chosen.socket, chosen.info)
    })
  }

  async flushed () {
    if (this._discovery) await this._discovery.flushed()
  }

  _addTimer (t) { this._timers.push(t) }

  _clearTimers () {
    for (const t of this._timers) clearTimeout(t)
    this._timers = []
  }

  async close () {
    if (this.closed) return
    this.closed = true
    this._clearTimers()
    if (this._selectTimer) { clearTimeout(this._selectTimer); this._selectTimer = null }
    for (const c of this._candidates) { try { c.frames.destroy() } catch {} }
    this._candidates = []
    if (this._lan) { try { this._lan.close() } catch {} this._lan = null }
    for (const s of this._pendingSockets) {
      try { s.destroy() } catch {}
    }
    if (this.frames) this.frames.destroy()
    if (this.swarm) {
      await this.swarm.destroy().catch(() => {})
      this.swarm = null
    }
  }
}

// Best-effort description of the connection type for the UI.
function describeConnection (socket, info) {
  try {
    if (info && info.lan) return 'direct (local network)'
    const raw = socket.rawStream
    if (raw && typeof raw.relayedBy !== 'undefined') {
      return raw.relayedBy ? 'relayed' : 'direct'
    }
    if (info && typeof info.client === 'boolean') return 'direct'
  } catch {}
  return null
}

module.exports = { SwarmSession, authenticate, channelBinding, CODE_TTL_MS, JOIN_TIMEOUT_MS, MAX_AUTH_FAILURES }
