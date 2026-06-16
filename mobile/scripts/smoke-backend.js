'use strict'

// Smoke test for the mobile backend bridge, runnable on plain Node.
// It mocks the nodejs-mobile "rn-bridge" channel, loads main.js, and checks the
// command/error wiring without touching the network. Run: node mobile/scripts/smoke-backend.js

const path = require('path')
const Module = require('module')
const { EventEmitter } = require('events')
const assert = require('assert')

// Mock the rn-bridge module the backend expects.
const sent = []
const channel = new EventEmitter()
channel.send = (s) => sent.push(JSON.parse(s))
const mock = { channel }

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'rn-bridge') return mock
  return origLoad.call(this, request, parent, isMain)
}

// Resolve hyperswarm & friends from the repo root node_modules.
const backend = path.join(__dirname, '..', 'nodejs-assets', 'nodejs-project', 'main.js')
require(backend)

function lastOfType (type) { return [...sent].reverse().find((m) => m.type === type) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  // 1. backend announces it is ready on load
  assert.ok(sent.find((m) => m.type === 'ready'), 'ready message emitted')

  // 2. malformed input does not crash
  channel.emit('message', '{not json')
  channel.emit('message', JSON.stringify({ cmd: 'unknown' }))

  // 3. receive with an invalid code -> clean error, no crash, no DHT
  channel.emit('message', JSON.stringify({ cmd: 'receive', code: 'nope', destDir: '/tmp' }))
  await wait(50)
  const e1 = lastOfType('error')
  assert.ok(e1 && /Invalid code/i.test(e1.data.message), 'invalid code -> error event')

  // 4. send with a missing path -> clean error, no crash, no DHT
  channel.emit('message', JSON.stringify({ cmd: 'send', paths: ['/no/such/file'], options: {} }))
  await wait(50)
  const e2 = lastOfType('error')
  assert.ok(e2 && e2.data.message, 'missing path -> error event')

  console.log('mobile backend smoke: OK')
  process.exit(0)
})().catch((err) => { console.error('mobile backend smoke FAILED:', err.message); process.exit(1) })
