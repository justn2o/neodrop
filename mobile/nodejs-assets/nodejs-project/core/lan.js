'use strict'

// Optional local-network discovery (mDNS), in addition to the DHT. When both
// peers are on the same network they find each other in milliseconds and
// connect directly. The TCP socket is wrapped in the same Noise protocol as
// Hyperswarm, so end-to-end encryption is preserved; authentication is still
// the HMAC challenge-response in swarm.js. Any failure (no interface, multicast
// blocked) just disables the LAN path and the DHT takes over. The advertised
// label is a digest of the topic, not the topic itself.

const os = require('os')
const net = require('net')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const NoiseSecretStream = require('@hyperswarm/secret-stream')

function lanIPv4 () {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

class LanDiscovery extends EventEmitter {
  constructor (topic) {
    super()
    this.label = crypto.createHash('sha256').update(topic).digest('hex').slice(0, 24) + '.neodrop.local'
    this.ip = lanIPv4()
    this.mdns = null
    this.server = null
    this.port = 0
    this.closed = false
    this._timer = null
    this._seen = new Set()
  }

  start () {
    if (!this.ip) return
    try {
      this.server = net.createServer((socket) => this._onTcp(socket, false))
      this.server.on('error', () => {})
      this.server.listen(0, () => {
        this.port = this.server.address().port
        this._startMdns()
      })
    } catch {
      this.close()
    }
  }

  _startMdns () {
    try {
      this.mdns = require('multicast-dns')()
    } catch {
      return
    }
    this.mdns.on('error', () => {})
    this.mdns.on('query', (q) => this._onQuery(q))
    this.mdns.on('response', (r, rinfo) => this._onResponse(r, rinfo))
    this._query()
    this._timer = setInterval(() => this._query(), 2000)
    if (this._timer.unref) this._timer.unref()
  }

  _query () {
    if (this.closed || !this.mdns) return
    try { this.mdns.query({ questions: [{ name: this.label, type: 'TXT' }] }) } catch {}
  }

  _onQuery (q) {
    if (this.closed || !this.mdns) return
    const asked = (q.questions || []).some((qq) => qq.name === this.label)
    if (!asked) return
    try {
      this.mdns.respond({
        answers: [
          { name: this.label, type: 'A', ttl: 120, data: this.ip },
          { name: this.label, type: 'TXT', ttl: 120, data: [`port=${this.port}`] }
        ]
      })
    } catch {}
  }

  _onResponse (r, rinfo) {
    if (this.closed) return
    const records = (r.answers || []).concat(r.additionals || [])
    if (!records.some((a) => a.name === this.label)) return
    let ip = null
    let port = 0
    for (const a of records) {
      if (a.name !== this.label) continue
      if (a.type === 'A') ip = a.data
      if (a.type === 'TXT') {
        const txt = [].concat(a.data || []).map((b) => b.toString()).join(' ')
        const m = txt.match(/port=(\d+)/)
        if (m) port = Number(m[1])
      }
    }
    if (!ip) ip = rinfo && rinfo.address
    if (!ip || !port) return
    if (ip === this.ip && port === this.port) return
    const key = `${ip}:${port}`
    if (this._seen.has(key)) return
    this._seen.add(key)
    const socket = net.connect(port, ip)
    socket.on('error', () => {})
    socket.once('connect', () => this._onTcp(socket, true))
  }

  _onTcp (rawSocket, initiator) {
    rawSocket.on('error', () => {})
    if (this.closed) { try { rawSocket.destroy() } catch {}; return }
    let enc
    try {
      enc = new NoiseSecretStream(initiator, rawSocket)
    } catch {
      try { rawSocket.destroy() } catch {}
      return
    }
    enc.on('error', () => {})
    this.emit('connection', enc, { client: initiator, lan: true })
  }

  close () {
    if (this.closed) return
    this.closed = true
    if (this._timer) clearInterval(this._timer)
    try { this.mdns && this.mdns.destroy() } catch {}
    try { this.server && this.server.close() } catch {}
  }
}

module.exports = { LanDiscovery }
