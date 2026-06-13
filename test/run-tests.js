'use strict'

// NeoDrop test suite (no Electron): npm test
// code.js, swarm.js and transfer.js are Electron-independent and run on plain
// Node. Transfers run over real local TCP sockets; one optional test goes
// through a local HyperDHT testnet.

const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const b4a = require('b4a')

const { WORDS, generateCode, normalizeCode, deriveSecrets, CODE_REGEX } = require('../src/main/code')
const { authenticate } = require('../src/main/swarm')
const {
  FrameStream, TransferSender, TransferReceiver,
  sanitizeFilename, sanitizeRelPath, hashFile, shouldCompress, CHUNK_SIZE
} = require('../src/main/transfer')

let tmpRoot

const tests = []
function test (name, fn) { tests.push({ name, fn }) }

async function run () {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'neodrop-test-'))
  let failed = 0
  for (const { name, fn } of tests) {
    const t0 = Date.now()
    try {
      await fn()
      console.log(`  ok ${name} (${Date.now() - t0} ms)`)
    } catch (err) {
      failed++
      console.error(`  FAIL ${name}`)
      console.error(`    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`)
    }
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  console.log(failed === 0 ? `\nAll tests pass (${tests.length}).` : `\n${failed} test(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

function makeSocketPair () {
  return new Promise((resolve, reject) => {
    const server = net.createServer((serverSide) => {
      server.close()
      serverSide.setNoDelay(true)
      resolve([clientSide, serverSide])
    })
    server.on('error', reject)
    let clientSide
    server.listen(0, '127.0.0.1', () => {
      clientSide = net.connect(server.address().port, '127.0.0.1')
      clientSide.setNoDelay(true)
    })
  })
}

function once (emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

async function makeTempFile (name, size, fill = null) {
  const p = path.join(tmpRoot, name)
  const fd = await fsp.open(p, 'w')
  const block = fill || crypto.randomBytes(Math.min(size, 1024 * 1024))
  let written = 0
  while (written < size) {
    const n = Math.min(block.length, size - written)
    await fd.write(block, 0, n)
    written += n
  }
  await fd.close()
  return p
}

// entries: file paths or { path, relPath } objects (folders).
async function makePair (entries, { autoAccept = true, destDir, resumeDir, compression = true } = {}) {
  const [a, b] = await makeSocketPair()
  const framesA = new FrameStream(a)
  const framesB = new FrameStream(b)
  const { authKey } = await deriveSecrets('TEST-0001')
  const [okA, okB] = await Promise.all([
    authenticate(framesA, { authKey, role: 'sender' }),
    authenticate(framesB, { authKey, role: 'receiver' })
  ])
  assert.ok(okA && okB, 'harness authentication')

  const sender = new TransferSender(framesA, entries, { senderName: 'PC-test', compression })
  const receiver = new TransferReceiver(framesB, { resumeDir })
  if (autoAccept) {
    receiver.on('offer', () => receiver.accept(destDir))
  }
  return { sender, receiver, framesA, framesB, socketA: a, socketB: b }
}

/* code.js */

test('code.js: word list is valid (>= 512, unique, no accents)', () => {
  assert.ok(WORDS.length >= 512, `only ${WORDS.length} words`)
  assert.strictEqual(new Set(WORDS).size, WORDS.length, 'duplicate words')
  for (const w of WORDS) assert.match(w, /^[A-Z]{2,12}$/)
})

test('code.js: generateCode produces the right format', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateCode()
    const m = code.match(CODE_REGEX)
    assert.ok(m, `invalid format: ${code}`)
    assert.ok(WORDS.includes(m[1]))
  }
})

test('code.js: normalizeCode tolerates input variants', () => {
  assert.strictEqual(normalizeCode(' tiger-7342 '), 'TIGER-7342')
  assert.strictEqual(normalizeCode('TIGER 7342'), 'TIGER-7342')
  assert.strictEqual(normalizeCode('tiger7342'), 'TIGER-7342')
  assert.strictEqual(normalizeCode('TIGER--7342'), 'TIGER-7342')
  assert.strictEqual(normalizeCode('TIGER-734'), null)
  assert.strictEqual(normalizeCode('TIGER-73422'), null)
  assert.strictEqual(normalizeCode(''), null)
  assert.strictEqual(normalizeCode(null), null)
  assert.strictEqual(normalizeCode('7342-TIGER'), null)
})

test('code.js: deterministic derivation, topic != auth key', async () => {
  const s1 = await deriveSecrets('TIGER-7342')
  const s2 = await deriveSecrets('TIGER-7342')
  const s3 = await deriveSecrets('TIGER-7343')
  assert.strictEqual(s1.topic.toString('hex'), s2.topic.toString('hex'))
  assert.strictEqual(s1.authKey.toString('hex'), s2.authKey.toString('hex'))
  assert.notStrictEqual(s1.topic.toString('hex'), s3.topic.toString('hex'))
  assert.notStrictEqual(s1.topic.toString('hex'), s1.authKey.toString('hex'))
  assert.strictEqual(s1.topic.length, 32)
})

test('code.js: stronger codes (2-3 words) generate and normalize', () => {
  for (const [strength, n] of [['normal', 1], ['high', 2], ['max', 3]]) {
    for (let i = 0; i < 50; i++) {
      const code = generateCode({ strength })
      const m = code.match(CODE_REGEX)
      assert.ok(m, `invalid format: ${code}`)
      const words = m[1].split('-')
      assert.strictEqual(words.length, n, `${strength} -> ${n} word(s)`)
      for (const w of words) assert.ok(WORDS.includes(w))
      assert.strictEqual(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code)
    }
  }
  assert.strictEqual(generateCode({ words: 9 }).split('-').length, 4)
  assert.strictEqual(generateCode({ words: 0 }).split('-').length, 2)
})

test('code.js: passphrase changes secrets and stays deterministic', async () => {
  const base = await deriveSecrets('TIGER-7342')
  const withPass = await deriveSecrets('TIGER-7342', 'my secret')
  const withPass2 = await deriveSecrets('TIGER-7342', 'my secret')
  const otherPass = await deriveSecrets('TIGER-7342', 'other')
  assert.notStrictEqual(base.topic.toString('hex'), withPass.topic.toString('hex'))
  assert.notStrictEqual(base.authKey.toString('hex'), withPass.authKey.toString('hex'))
  assert.notStrictEqual(withPass.authKey.toString('hex'), otherPass.authKey.toString('hex'))
  assert.strictEqual(withPass.topic.toString('hex'), withPass2.topic.toString('hex'))
  assert.strictEqual(withPass.authKey.toString('hex'), withPass2.authKey.toString('hex'))
})

/* sanitizeFilename */

test('transfer.js: sanitizeFilename neutralizes paths and hostile names', () => {
  assert.strictEqual(sanitizeFilename('../../../etc/passwd'), 'passwd')
  assert.strictEqual(sanitizeFilename('..\\..\\windows\\system32\\evil.dll'), 'evil.dll')
  assert.strictEqual(sanitizeFilename('a<b>c:d"e.txt'), 'a_b_c_d_e.txt')
  assert.strictEqual(sanitizeFilename('normal file - v2.txt'), 'normal file - v2.txt')
  assert.strictEqual(sanitizeFilename('CON.txt'), '_CON.txt')
  assert.strictEqual(sanitizeFilename('nul'), '_nul')
  assert.strictEqual(sanitizeFilename('end of name. . .'), 'end of name')
  assert.strictEqual(sanitizeFilename(''), 'file')
  assert.strictEqual(sanitizeFilename('..'), 'file')
  assert.strictEqual(sanitizeFilename('x\ty.txt'), 'x_y.txt')
  assert.ok(sanitizeFilename('a'.repeat(300) + '.txt').length <= 200)
})

/* framing */

test('transfer.js: FrameStream exchanges JSON and binary, fragmented frames', async () => {
  const [a, b] = await makeSocketPair()
  const fa = new FrameStream(a)
  const fb = new FrameStream(b)

  const gotJson = once(fb, 'json')
  fa.sendJson({ t: 'PING', value: 42, text: 'hey' })
  assert.deepStrictEqual(await gotJson, { t: 'PING', value: 42, text: 'hey' })

  const payload = crypto.randomBytes(CHUNK_SIZE)
  const gotChunk = once(fa, 'chunk')
  fb.sendChunk(payload)
  assert.strictEqual(Buffer.compare(await gotChunk, payload), 0)

  const gotErr = once(fb, 'error')
  const evil = Buffer.alloc(5)
  evil.writeUInt32BE(10 * 1024 * 1024, 0)
  a.write(evil)
  assert.ok((await gotErr) instanceof Error)

  fa.destroy(); fb.destroy()
})

/* challenge-response */

test('swarm.js: mutual authentication succeeds with the same code', async () => {
  const [a, b] = await makeSocketPair()
  const { authKey } = await deriveSecrets('WOLF-1234')
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey, role: 'sender' }),
    authenticate(new FrameStream(b), { authKey, role: 'receiver' })
  ])
  assert.strictEqual(okA, true)
  assert.strictEqual(okB, true)
  a.destroy(); b.destroy()
})

test('swarm.js: a wrong code is rejected on both sides', async () => {
  const [a, b] = await makeSocketPair()
  const k1 = (await deriveSecrets('WOLF-1234')).authKey
  const k2 = (await deriveSecrets('WOLF-1235')).authKey
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey: k1, role: 'sender', timeout: 3000 }),
    authenticate(new FrameStream(b), { authKey: k2, role: 'receiver', timeout: 3000 })
  ])
  assert.strictEqual(okA, false)
  assert.strictEqual(okB, false)
  a.destroy(); b.destroy()
})

test('swarm.js: reflecting HELLO with the same role is rejected', async () => {
  const [a, b] = await makeSocketPair()
  const { authKey } = await deriveSecrets('WOLF-1234')
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey, role: 'sender', timeout: 3000 }),
    authenticate(new FrameStream(b), { authKey, role: 'sender', timeout: 3000 })
  ])
  assert.strictEqual(okA, false)
  assert.strictEqual(okB, false)
  a.destroy(); b.destroy()
})

test('swarm.js: channel binding - same handshakeHash OK, divergent rejected', async () => {
  const { authKey } = await deriveSecrets('WOLF-1234')
  {
    const [a, b] = await makeSocketPair()
    const hh = crypto.randomBytes(32)
    a.handshakeHash = hh; b.handshakeHash = hh
    const [okA, okB] = await Promise.all([
      authenticate(new FrameStream(a), { authKey, role: 'sender', timeout: 3000 }),
      authenticate(new FrameStream(b), { authKey, role: 'receiver', timeout: 3000 })
    ])
    assert.ok(okA && okB, 'same handshakeHash -> authenticated')
    a.destroy(); b.destroy()
  }
  {
    const [a, b] = await makeSocketPair()
    a.handshakeHash = crypto.randomBytes(32)
    b.handshakeHash = crypto.randomBytes(32)
    const [okA, okB] = await Promise.all([
      authenticate(new FrameStream(a), { authKey, role: 'sender', timeout: 3000 }),
      authenticate(new FrameStream(b), { authKey, role: 'receiver', timeout: 3000 })
    ])
    assert.strictEqual(okA, false, 'divergent handshakeHash -> reject (sender)')
    assert.strictEqual(okB, false, 'divergent handshakeHash -> reject (receiver)')
    a.destroy(); b.destroy()
  }
})

test('swarm.js: deterministic connection selection - both peers converge', () => {
  const { SwarmSession } = require('../src/main/swarm')
  // 3 concurrent connections (e.g. 1 DHT + 2 crossed LAN); each connection has
  // a handshakeHash shared by both ends.
  const hashes = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)]
  const mockFrames = (hh) => ({
    socket: { handshakeHash: hh }, destroyed: false,
    destroy () { this.destroyed = true }, on () {}
  })
  const pick = (order) => {
    const s = new SwarmSession({ code: 'TEST-0001', role: 'sender' })
    let chosen = null
    s.on('peer-authenticated', ({ frames }) => { chosen = frames.socket.handshakeHash })
    for (const i of order) { const f = mockFrames(hashes[i]); s._addCandidate(f, f.socket, {}) }
    s._select()
    s.closed = true
    return chosen
  }
  const a = pick([0, 1, 2])
  const b = pick([2, 0, 1])
  assert.ok(a && b)
  assert.strictEqual(b4a.compare(a, b), 0, 'both peers converge on the same connection')
})

/* end-to-end transfer */

test('transfer: multi-file complete with hash verification', async () => {
  const f1 = await makeTempFile('small.txt', 13, Buffer.from('Hello P2P!!!!'))
  const f2 = await makeTempFile('medium.bin', 3 * CHUNK_SIZE + 777)
  const destDir = path.join(tmpRoot, 'recv-multi')

  const { sender, receiver } = await makePair([f1, f2], { destDir })

  let offer = null
  receiver.on('offer', (o) => { offer = o })
  const progressEvents = []
  receiver.on('progress', (p) => progressEvents.push(p))

  const doneR = once(receiver, 'done')
  const doneS = once(sender, 'done')
  await sender.start()
  const [resR] = await Promise.all([doneR, doneS])

  assert.ok(offer, 'offer received')
  assert.strictEqual(offer.sender, 'PC-test')
  assert.strictEqual(offer.files.length, 2)
  assert.ok(offer.files[0].sha256, 'hash precomputed for small files')

  assert.strictEqual(resR.files.length, 2)
  for (let i = 0; i < 2; i++) {
    const src = [f1, f2][i]
    const dst = resR.files[i].path
    assert.strictEqual(await hashFile(dst), await hashFile(src), 'identical content')
  }
  assert.ok(progressEvents.length > 0, 'progress events emitted')
  const last = progressEvents[progressEvents.length - 1]
  assert.strictEqual(last.totalBytes, 13 + 3 * CHUNK_SIZE + 777)
  const leftovers = (await fsp.readdir(destDir)).filter((n) => n.endsWith('.part'))
  assert.deepStrictEqual(leftovers, [])
})

test('transfer.js: sanitizeRelPath neutralizes ".." and keeps the tree', () => {
  assert.strictEqual(sanitizeRelPath('photos/2024/a.jpg'), path.join('photos', '2024', 'a.jpg'))
  assert.strictEqual(sanitizeRelPath('a/../../../etc/passwd'), path.join('a', 'etc', 'passwd'))
  assert.strictEqual(sanitizeRelPath('a\\b\\c.txt'), path.join('a', 'b', 'c.txt'))
  assert.strictEqual(sanitizeRelPath('./x/./y'), path.join('x', 'y'))
  assert.strictEqual(sanitizeRelPath('../..'), null)
  assert.strictEqual(sanitizeRelPath(''), null)
})

test('transfer: full folder - tree recreated and verified', async () => {
  const root = path.join(tmpRoot, 'myfolder')
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(root, 'a.txt'), 'file A')
  await makeTempFile(path.join('myfolder', 'sub', 'b.bin'), 2 * CHUNK_SIZE + 5)
  await fsp.writeFile(path.join(root, 'sub', 'c.txt'), 'file C')

  const entries = [
    { path: path.join(root, 'a.txt'), relPath: 'myfolder/a.txt' },
    { path: path.join(root, 'sub', 'b.bin'), relPath: 'myfolder/sub/b.bin' },
    { path: path.join(root, 'sub', 'c.txt'), relPath: 'myfolder/sub/c.txt' }
  ]
  const destDir = path.join(tmpRoot, 'recv-folder')

  let offer = null
  const { sender, receiver } = await makePair(entries, { destDir })
  receiver.on('offer', (o) => { offer = o })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(offer.folder, true, 'offer marked as folder')
  assert.strictEqual(res.files.length, 3)
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'myfolder', 'a.txt'), 'utf8'), 'file A')
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'myfolder', 'sub', 'c.txt'), 'utf8'), 'file C')
  assert.strictEqual(
    await hashFile(path.join(destDir, 'myfolder', 'sub', 'b.bin')),
    await hashFile(path.join(root, 'sub', 'b.bin'))
  )
})

test('transfer: a received folder whose name exists -> root suffixed', async () => {
  const root = path.join(tmpRoot, 'docs')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'x.txt'), 'X')
  await fsp.writeFile(path.join(root, 'y.txt'), 'Y')
  const destDir = path.join(tmpRoot, 'recv-folder-collision')
  await fsp.mkdir(path.join(destDir, 'docs'), { recursive: true })

  const entries = [
    { path: path.join(root, 'x.txt'), relPath: 'docs/x.txt' },
    { path: path.join(root, 'y.txt'), relPath: 'docs/y.txt' }
  ]
  const { sender, receiver } = await makePair(entries, { destDir })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  for (const f of res.files) {
    assert.ok(f.path.includes(`docs (1)${path.sep}`), `expected under docs (1): ${f.path}`)
  }
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'docs (1)', 'x.txt'), 'utf8'), 'X')
})

test('security: an OFFER with duplicate ids is rejected', async () => {
  const [a, b] = await makeSocketPair()
  const framesA = new FrameStream(a)
  const framesB = new FrameStream(b)
  const { authKey } = await deriveSecrets('TEST-0001')
  await Promise.all([
    authenticate(framesA, { authKey, role: 'sender' }),
    authenticate(framesB, { authKey, role: 'receiver' })
  ])
  const receiver = new TransferReceiver(framesB)
  const errP = once(receiver, 'error')
  framesA.sendJson({
    t: 'OFFER',
    sender: 'attacker',
    files: [
      { id: 0, name: 'a.txt', size: 1, sha256: null },
      { id: 0, name: 'b.txt', size: 1, sha256: null }
    ]
  })
  const err = await errP
  assert.match(err.message, /duplicate/i)
  a.destroy(); b.destroy()
})

test('robustness: dispose() does not crash on teardown mid-transfer', async () => {
  const src = await makeTempFile('dispose.bin', 30 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recv-dispose')
  const { sender, receiver, framesA, framesB } = await makePair([src], { destDir })

  await new Promise((resolve) => {
    receiver.once('progress', resolve)
    sender.start()
  })
  await receiver.dispose()
  sender.dispose()
  framesA.destroy()
  framesB.destroy()
  await new Promise((r) => setTimeout(r, 150))
  const leftover = fs.existsSync(destDir)
    ? (await fsp.readdir(destDir)).filter((n) => n.endsWith('.part'))
    : []
  assert.deepStrictEqual(leftover, [], '.part cleaned by dispose()')
})

test('transfer: name collision -> "file (1).ext"', async () => {
  const src = await makeTempFile('collision.txt', 20)
  const destDir = path.join(tmpRoot, 'recv-collision')
  await fsp.mkdir(destDir, { recursive: true })
  await fsp.writeFile(path.join(destDir, 'collision.txt'), 'already here')

  const { sender, receiver } = await makePair([src], { destDir })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(path.basename(res.files[0].path), 'collision (1).txt')
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'collision.txt'), 'utf8'), 'already here')
})

test('transfer: nothing written before acceptance, clean REJECT', async () => {
  const src = await makeTempFile('private.txt', 100)
  const destDir = path.join(tmpRoot, 'recv-reject')

  const { sender, receiver } = await makePair([src], { autoAccept: false })
  const offerP = once(receiver, 'offer')
  const rejectedP = once(sender, 'rejected')
  sender.start()
  await offerP
  assert.strictEqual(fs.existsSync(destDir), false)
  receiver.reject()
  await rejectedP
  assert.strictEqual(fs.existsSync(destDir), false)
})

test('transfer: file corrupted in transit -> rejected, .part deleted', async () => {
  const src = await makeTempFile('corrupt.bin', 5 * CHUNK_SIZE)
  const destDir = path.join(tmpRoot, 'recv-corrupt')

  const { sender, receiver, framesA } = await makePair([src], { destDir })

  const origSendChunk = framesA.sendChunk.bind(framesA)
  let chunkIndex = 0
  framesA.sendChunk = (buf) => {
    chunkIndex++
    if (chunkIndex === 2) {
      const evil = Buffer.from(buf)
      evil[0] ^= 0xff
      return origSendChunk(evil)
    }
    return origSendChunk(buf)
  }

  const errR = once(receiver, 'error')
  const errS = once(sender, 'error')
  sender.start()
  const [eR, eS] = await Promise.all([errR, errS])

  assert.match(eR.message, /corrupt/i)
  assert.match(eS.message, /rejected/i)
  const files = fs.existsSync(destDir) ? await fsp.readdir(destDir) : []
  assert.deepStrictEqual(files, [], 'the corrupt .part must be deleted')
})

test('transfer: connection drop mid-transfer -> error + cleanup', async () => {
  const src = await makeTempFile('cut.bin', 50 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recv-cut')

  const { sender, receiver, socketA } = await makePair([src], { destDir })

  const errR = once(receiver, 'error')
  const errS = once(sender, 'error')
  receiver.once('progress', () => socketA.destroy())
  sender.start()
  const [eR, eS] = await Promise.all([errR, errS])

  assert.match(eR.message, /lost/i)
  assert.match(eS.message, /lost/i)
  await new Promise((r) => setTimeout(r, 100))
  const files = fs.existsSync(destDir) ? await fsp.readdir(destDir) : []
  assert.deepStrictEqual(files.filter((n) => n.endsWith('.part')), [], '.part cleaned')
})

test('transfer: cancel by the recipient during the transfer', async () => {
  const src = await makeTempFile('cancel.bin', 50 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recv-cancel')

  const { sender, receiver } = await makePair([src], { destDir })

  const cancelledS = once(sender, 'cancelled')
  const cancelledR = once(receiver, 'cancelled')
  receiver.once('progress', () => receiver.cancel())
  sender.start()
  const [byS, byR] = await Promise.all([cancelledS, cancelledR])

  assert.strictEqual(byS.by, 'peer')
  assert.strictEqual(byR.by, 'local')
  await new Promise((r) => setTimeout(r, 100))
  const files = fs.existsSync(destDir) ? await fsp.readdir(destDir) : []
  assert.deepStrictEqual(files.filter((n) => n.endsWith('.part')), [], '.part cleaned')
})

test('transfer: large file streaming, bounded RAM (< 200 MB)', async function () {
  const size = 300 * 1024 * 1024
  const src = await makeTempFile('big.bin', size)
  const destDir = path.join(tmpRoot, 'recv-big')

  global.gc && global.gc()
  const rssBefore = process.memoryUsage().rss

  const { sender, receiver } = await makePair([src], { destDir })
  let rssPeak = 0
  const meter = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  }, 50)

  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR
  clearInterval(meter)

  const deltaMb = (rssPeak - rssBefore) / (1024 * 1024)
  assert.ok(deltaMb < 200, `memory peak: +${deltaMb.toFixed(0)} MB (limit 200)`)
  const st = await fsp.stat(res.files[0].path)
  assert.strictEqual(st.size, size)
  assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
})

test('transfer.js: shouldCompress only targets compressible formats', () => {
  assert.strictEqual(shouldCompress('report.txt', 100000), true)
  assert.strictEqual(shouldCompress('data.json', 5000), true)
  assert.strictEqual(shouldCompress('small.txt', 100), false)
  assert.strictEqual(shouldCompress('photo.jpg', 5_000_000), false)
  assert.strictEqual(shouldCompress('archive.zip', 5_000_000), false)
  assert.strictEqual(shouldCompress('movie.mp4', 50_000_000), false)
})

test('transfer: on-the-fly compression, integrity preserved', async () => {
  const text = Buffer.from('NeoDrop peer-to-peer, brotli transport compression. ')
  const src = await makeTempFile('big.txt', 2 * 1024 * 1024, text)
  const destDir = path.join(tmpRoot, 'recv-compress')

  const { sender, receiver } = await makePair([src], { destDir, compression: true })
  let offer = null
  receiver.on('offer', (o) => { offer = o })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(offer.compression, true, 'offer announces compression')
  assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
  const st = await fsp.stat(res.files[0].path)
  assert.strictEqual(st.size, 2 * 1024 * 1024)
})

test('transfer: pipeline of many small files', async () => {
  const entries = []
  for (let i = 0; i < 25; i++) {
    const p = await makeTempFile(`p${i}.dat`, 1500 + i, Buffer.from(`file number ${i} `))
    entries.push({ path: p, relPath: `batch/p${i}.dat` })
  }
  const destDir = path.join(tmpRoot, 'recv-pipeline')
  const { sender, receiver } = await makePair(entries, { destDir })
  const doneEvents = []
  receiver.on('file-done', (f) => doneEvents.push(f))
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(res.files.length, 25)
  assert.strictEqual(doneEvents.length, 25, 'one file-done per file')
  for (let i = 0; i < 25; i++) {
    const dst = path.join(destDir, 'batch', `p${i}.dat`)
    assert.strictEqual(await hashFile(dst), await hashFile(entries[i].path))
  }
})

test('transfer: resume after a drop via the resume cache', async () => {
  const size = 24 * 1024 * 1024
  const src = await makeTempFile('resume.bin', size)
  const destDir = path.join(tmpRoot, 'recv-resume')
  const resumeDir = path.join(tmpRoot, 'resume-cache')

  // First attempt: deterministic cut at the 40th chunk (~2.5 MB of 24), which
  // does not depend on local loop speed (it can otherwise finish first).
  {
    const { sender, receiver, framesA, socketA } = await makePair([src], { destDir, resumeDir, compression: false })
    const errR = once(receiver, 'error')
    const errS = once(sender, 'error')
    let n = 0
    const origSend = framesA.sendChunk.bind(framesA)
    framesA.sendChunk = (buf) => { if (++n === 40) socketA.destroy(); return origSend(buf) }
    sender.start()
    await Promise.all([errR, errS])
    await new Promise((r) => setTimeout(r, 150))
  }

  const partials = (await fsp.readdir(resumeDir)).filter((n) => n.endsWith('.part'))
  assert.strictEqual(partials.length, 1, 'one partial kept for resume')
  const partialBytes = (await fsp.stat(path.join(resumeDir, partials[0]))).size
  assert.ok(partialBytes > 0 && partialBytes < size, `non-trivial partial: ${partialBytes}`)

  // Second attempt: same entry, same cache -> resume then complete.
  {
    const { sender, receiver } = await makePair([src], { destDir, resumeDir, compression: false })
    let resumeAnnounced = null
    receiver.on('offer', async () => {
      await receiver.accept(destDir)
    })
    const origStart = sender._streamFile.bind(sender)
    sender._streamFile = (fp, meta, prog, opts) => {
      resumeAnnounced = opts.startOffset
      return origStart(fp, meta, prog, opts)
    }
    const doneR = once(receiver, 'done')
    await sender.start()
    const res = await doneR

    assert.ok(resumeAnnounced > 0, `resume started at offset > 0 (saw ${resumeAnnounced})`)
    assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
    const left = (await fsp.readdir(resumeDir)).filter((n) => n.endsWith('.part'))
    assert.deepStrictEqual(left, [], 'resume cache cleared after completion')
  }
})

/* end-to-end over Hyperswarm (local DHT) */

function localDhtOpts (testnet) {
  const HyperDHT = require('hyperdht')
  return { dht: new HyperDHT({ bootstrap: testnet.bootstrap, firewalled: false }) }
}

test('hyperswarm: discovery + auth + full transfer over local DHT', async () => {
  const createTestnet = require('hyperdht/testnet')
  const { SwarmSession } = require('../src/main/swarm')
  const testnet = await createTestnet(3)

  const src = await makeTempFile('via-dht.bin', 2 * CHUNK_SIZE + 123)
  const destDir = path.join(tmpRoot, 'recv-dht')
  const code = generateCode()

  const sSender = new SwarmSession({ code, role: 'sender', swarmOpts: localDhtOpts(testnet) })
  const sReceiver = new SwarmSession({ code, role: 'receiver', swarmOpts: localDhtOpts(testnet) })

  try {
    const authS = once(sSender, 'peer-authenticated')
    const authR = once(sReceiver, 'peer-authenticated')
    await sSender.start()
    await sSender.flushed()
    await sReceiver.start()
    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('no authenticated peer in 30s')), 30000))
    const [{ frames: framesS }, { frames: framesR }] =
      await Promise.race([Promise.all([authS, authR]), guard])

    const sender = new TransferSender(framesS, [src], { senderName: 'PC-dht' })
    const receiver = new TransferReceiver(framesR)
    receiver.on('offer', () => receiver.accept(destDir))
    const doneR = once(receiver, 'done')
    const doneS = once(sender, 'done')
    sender.start()
    const [res] = await Promise.race([Promise.all([doneR, doneS]), guard])

    assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
  } finally {
    await sSender.close()
    await sReceiver.close()
    await testnet.destroy()
  }
})

test('hyperswarm: a wrong code never grants access, 3 failures -> invalidation', async () => {
  const createTestnet = require('hyperdht/testnet')
  const HyperDHT = require('hyperdht')
  const { SwarmSession, authenticate: auth } = require('../src/main/swarm')
  const testnet = await createTestnet(3)

  const code = generateCode()
  const sSender = new SwarmSession({ code, role: 'sender', swarmOpts: localDhtOpts(testnet) })

  const { topic } = await deriveSecrets(code)
  const badKey = (await deriveSecrets('WRONG-0000')).authKey
  const attackerNode = new HyperDHT({ bootstrap: testnet.bootstrap, firewalled: false })

  try {
    const invalidated = once(sSender, 'invalidated')
    const failures = []
    sSender.on('auth-failed', (f) => failures.push(f))

    await sSender.start()
    await sSender.flushed()

    let peerKey = null
    for await (const entry of attackerNode.lookup(topic)) {
      if (entry.peers && entry.peers.length > 0) { peerKey = entry.peers[0].publicKey; break }
    }
    assert.ok(peerKey, 'announced peer visible on the DHT')

    for (let i = 0; i < 3; i++) {
      const socket = attackerNode.connect(peerKey)
      socket.on('error', () => {})
      const ok = await auth(new FrameStream(socket), { authKey: badKey, role: 'receiver', timeout: 8000 })
      assert.strictEqual(ok, false, 'the attacker must never be authenticated')
      socket.destroy()
    }

    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('no invalidation in 30s')), 30000))
    await Promise.race([invalidated, guard])

    assert.ok(failures.length >= 3, `expected 3 failures, saw ${failures.length}`)
    assert.strictEqual(sSender.closed, true, 'the invalidated code closes the session')
  } finally {
    await sSender.close()
    await attackerNode.destroy()
    await testnet.destroy()
  }
})

/* real DHT (opt-in, network required) */

if (process.env.NEODROP_TEST_DHT === '1') {
  test('DHT: two SwarmSessions find and authenticate over Hyperswarm', async () => {
    const { SwarmSession } = require('../src/main/swarm')
    const { generateCode } = require('../src/main/code')
    const code = generateCode()

    const sSender = new SwarmSession({ code, role: 'sender' })
    const sReceiver = new SwarmSession({ code, role: 'receiver' })
    try {
      const authSender = once(sSender, 'peer-authenticated')
      const authReceiver = once(sReceiver, 'peer-authenticated')
      await sSender.start()
      await sReceiver.start()
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('no peer in 60s (restricted network?)')), 60000))
      await Promise.race([Promise.all([authSender, authReceiver]), timeout])
    } finally {
      await sSender.close()
      await sReceiver.close()
    }
  })
}

run()
