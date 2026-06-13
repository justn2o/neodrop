'use strict'

/**
 * Découverte des pairs via la DHT publique Hyperswarm et authentification
 * mutuelle par challenge-réponse.
 *
 * Les deux pairs rejoignent le topic dérivé du code (voir code.js). Les
 * sockets Hyperswarm sont chiffrées de bout en bout (protocole Noise)
 * nativement. Par-dessus, chaque pair prouve qu'il connaît le code sans
 * jamais le transmettre :
 *
 *   A → B : HELLO { nonce_A, role_A }
 *   B → A : HELLO { nonce_B, role_B }
 *   A → B : AUTH  { mac = HMAC-SHA256(authKey, nonce_B || role_A) }
 *   B → A : AUTH  { mac = HMAC-SHA256(authKey, nonce_A || role_B) }
 *   les deux : AUTH_OK si la preuve reçue est valide, sinon déconnexion.
 *
 * Le rôle (sender/receiver) est inclus dans le HMAC pour empêcher une
 * attaque par réflexion (renvoyer la preuve de l'autre pair).
 *
 * Côté expéditeur : 3 échecs d'authentification invalident le code.
 * Le code expire après 15 minutes sans transfert (usage unique).
 */

const crypto = require('crypto')
const { EventEmitter } = require('events')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const { deriveSecrets } = require('./code')
const { FrameStream } = require('./transfer')

const CODE_TTL_MS = 15 * 60 * 1000 // expiration du code : 15 minutes
const JOIN_TIMEOUT_MS = 30 * 1000 // côté destinataire : 30 s pour trouver le pair
const AUTH_TIMEOUT_MS = 15 * 1000 // délai max pour le challenge-réponse
const MAX_AUTH_FAILURES = 3 // côté expéditeur : 3 échecs → code invalidé

/**
 * Challenge-réponse mutuel sur une FrameStream : chaque pair prouve la
 * connaissance du code via HMAC(authKey, nonce_du_pair || son_rôle), sans
 * jamais transmettre le code. Résout true si le pair est authentifié.
 */
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
      // Retire TOUS les écouteurs posés ici : sinon error/close restent
      // attachés à la FrameStream après l'auth et fuient leurs closures.
      frames.off('json', onJson)
      frames.off('error', onError)
      frames.off('close', onClose)
      resolve(ok)
    }

    const onJson = (msg) => {
      try {
        if (msg.t === 'HELLO') {
          // Le rôle du pair doit être l'opposé du nôtre (anti-réflexion).
          if (peerNonce || msg.role !== peerRole) return settle(false)
          peerNonce = b4a.from(String(msg.nonce), 'hex')
          if (peerNonce.length !== 16) return settle(false)
          const mac = crypto.createHmac('sha256', authKey)
            .update(peerNonce).update(role).digest('hex')
          frames.sendJson({ t: 'AUTH', mac })
        } else if (msg.t === 'AUTH') {
          if (!peerNonce || peerProofOk) return settle(false)
          const expected = crypto.createHmac('sha256', authKey)
            .update(myNonce).update(peerRole).digest()
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
          settle(false) // tout autre message avant la fin de l'auth est hostile
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

/**
 * Une session de rendez-vous : rejoint le topic, authentifie le premier
 * pair valide et expose la FrameStream prête pour le transfert.
 *
 * Événements :
 *   'peer-connected'      un pair a ouvert une connexion (avant auth)
 *   'peer-authenticated'  ({ frames, connectionType }) prêt à transférer
 *   'auth-failed'         ({ failures, remaining }) mauvaise preuve reçue
 *   'invalidated'         3 échecs côté expéditeur → code mort
 *   'expired'             15 minutes sans pair authentifié
 *   'timeout'             (destinataire) personne trouvé en 30 s
 *   'error'
 */
class SwarmSession extends EventEmitter {
  constructor ({ code, role, swarmOpts = null }) {
    super()
    this.code = code
    this.role = role // 'sender' | 'receiver'
    // Options Hyperswarm alternatives (tests : DHT locale via bootstrap).
    // null = DHT publique avec auto-détection du pare-feu.
    this.swarmOpts = swarmOpts
    this.swarm = null
    this.authKey = null
    this.frames = null
    this.closed = false
    this.authFailures = 0
    this._discovery = null
    this._timers = []
    this._pendingSockets = new Set()
  }

  async start () {
    const { topic, authKey } = await deriveSecrets(this.code)
    if (this.closed) return
    this.authKey = authKey

    this.swarm = new Hyperswarm(this.swarmOpts || {})
    this.swarm.on('connection', (socket, info) => this._onConnection(socket, info))

    // Les deux côtés s'annoncent ET cherchent : peu importe qui est
    // joignable directement, la connexion s'établit dans un sens ou l'autre.
    this._discovery = this.swarm.join(topic, { server: true, client: true })
    this._discovery.flushed().catch(() => {})

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
    if (this.closed || this.frames) {
      // Déjà appairé : on refuse poliment les connexions supplémentaires.
      socket.destroy()
      return
    }
    this._pendingSockets.add(socket)
    socket.on('close', () => this._pendingSockets.delete(socket))
    socket.on('error', () => {}) // les erreurs pré-auth ne sont pas fatales
    // Détection rapide d'une connexion morte pendant le transfert.
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(5000)

    this.emit('peer-connected')
    this._authenticate(socket, info).catch(() => {
      try { socket.destroy() } catch {}
    })
  }

  /** Challenge-réponse mutuel sur cette connexion. */
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
      // Seul l'expéditeur invalide son code : c'est lui qui est attaquable
      // par des tentatives répétées sur le topic.
      if (this.role === 'sender' && this.authFailures >= MAX_AUTH_FAILURES) {
        this.emit('invalidated')
        this.close()
      }
      return
    }

    if (this.frames) {
      frames.destroy() // un autre pair a gagné la course
      return
    }

    this.frames = frames
    this._clearTimers() // le pair est là : plus d'expiration de rendez-vous
    this.emit('peer-authenticated', {
      frames,
      connectionType: describeConnection(socket, info)
    })
  }

  /** Résout quand l'annonce sur la DHT est complètement propagée. */
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

/**
 * Décrit le type de connexion pour l'UI (« directe » ou « relayée »),
 * dans la mesure où l'information est exposée par la pile UDX.
 */
function describeConnection (socket, info) {
  try {
    const raw = socket.rawStream
    if (raw && typeof raw.relayedBy !== 'undefined') {
      return raw.relayedBy ? 'relayée' : 'directe'
    }
    if (info && typeof info.client === 'boolean') return 'directe'
  } catch {}
  return null
}

module.exports = { SwarmSession, authenticate, CODE_TTL_MS, JOIN_TIMEOUT_MS, MAX_AUTH_FAILURES }
