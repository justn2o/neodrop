'use strict'

/**
 * Suite de tests NeoDrop (sans Electron) : npm test
 *
 * Les modules code.js, swarm.js et transfer.js sont indépendants
 * d'Electron et se testent en Node pur. Le transfert est exercé sur de
 * vraies sockets TCP locales (mêmes sémantiques de flux que les sockets
 * Hyperswarm) ; un test optionnel passe par la vraie DHT publique si le
 * réseau le permet (NEODROP_TEST_DHT=1).
 */

const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const net = require('net')
const crypto = require('crypto')

const { WORDS, generateCode, normalizeCode, deriveSecrets, CODE_REGEX } = require('../src/main/code')
const { authenticate } = require('../src/main/swarm')
const {
  FrameStream, TransferSender, TransferReceiver,
  sanitizeFilename, sanitizeRelPath, hashFile, shouldCompress, CHUNK_SIZE
} = require('../src/main/transfer')

let tmpRoot

/* --------------------------- harnais ------------------------------ */

const tests = []
function test (name, fn) { tests.push({ name, fn }) }

async function run () {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'neodrop-test-'))
  let failed = 0
  for (const { name, fn } of tests) {
    const t0 = Date.now()
    try {
      await fn()
      console.log(`  ✓ ${name} (${Date.now() - t0} ms)`)
    } catch (err) {
      failed++
      console.error(`  ✗ ${name}`)
      console.error(`    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`)
    }
  }
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  console.log(failed === 0 ? `\nTous les tests passent (${tests.length}).` : `\n${failed} test(s) en échec.`)
  process.exit(failed === 0 ? 0 : 1)
}

/** Paire de sockets TCP locales reliées entre elles. */
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

/** Monte un couple expéditeur/destinataire prêt, avec auth réelle.
 *  entries : chemins (fichiers) ou objets { path, relPath } (dossiers). */
async function makePair (entries, { autoAccept = true, destDir, resumeDir, compression = true } = {}) {
  const [a, b] = await makeSocketPair()
  const framesA = new FrameStream(a)
  const framesB = new FrameStream(b)
  const { authKey } = await deriveSecrets('TEST-0001')
  const [okA, okB] = await Promise.all([
    authenticate(framesA, { authKey, role: 'sender' }),
    authenticate(framesB, { authKey, role: 'receiver' })
  ])
  assert.ok(okA && okB, 'authentification du harnais')

  const sender = new TransferSender(framesA, entries, { senderName: 'PC-test', compression })
  const receiver = new TransferReceiver(framesB, { resumeDir })
  if (autoAccept) {
    receiver.on('offer', () => receiver.accept(destDir))
  }
  return { sender, receiver, framesA, framesB, socketA: a, socketB: b }
}

/* ----------------------------- code.js ---------------------------- */

test('code.js : liste de mots valide (≥ 512, uniques, sans accents)', () => {
  assert.ok(WORDS.length >= 512, `seulement ${WORDS.length} mots`)
  assert.strictEqual(new Set(WORDS).size, WORDS.length, 'doublons dans la liste')
  for (const w of WORDS) assert.match(w, /^[A-Z]{2,12}$/)
})

test('code.js : generateCode produit le bon format', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateCode()
    const m = code.match(CODE_REGEX)
    assert.ok(m, `format invalide : ${code}`)
    assert.ok(WORDS.includes(m[1]))
  }
})

test('code.js : normalizeCode tolère les variantes de saisie', () => {
  assert.strictEqual(normalizeCode(' tigre-7342 '), 'TIGRE-7342')
  assert.strictEqual(normalizeCode('TIGRE 7342'), 'TIGRE-7342')
  assert.strictEqual(normalizeCode('tigre7342'), 'TIGRE-7342')
  assert.strictEqual(normalizeCode('TIGRE--7342'), 'TIGRE-7342')
  assert.strictEqual(normalizeCode('TIGRE-734'), null)
  assert.strictEqual(normalizeCode('TIGRE-73422'), null)
  assert.strictEqual(normalizeCode(''), null)
  assert.strictEqual(normalizeCode(null), null)
  assert.strictEqual(normalizeCode('7342-TIGRE'), null)
})

test('code.js : dérivation déterministe, topic ≠ clé d\'auth', async () => {
  const s1 = await deriveSecrets('TIGRE-7342')
  const s2 = await deriveSecrets('TIGRE-7342')
  const s3 = await deriveSecrets('TIGRE-7343')
  assert.strictEqual(s1.topic.toString('hex'), s2.topic.toString('hex'))
  assert.strictEqual(s1.authKey.toString('hex'), s2.authKey.toString('hex'))
  assert.notStrictEqual(s1.topic.toString('hex'), s3.topic.toString('hex'))
  assert.notStrictEqual(s1.topic.toString('hex'), s1.authKey.toString('hex'))
  assert.strictEqual(s1.topic.length, 32)
})

test('code.js : codes renforcés (2-3 mots) générés et normalisés', () => {
  for (const [strength, n] of [['normal', 1], ['high', 2], ['max', 3]]) {
    for (let i = 0; i < 50; i++) {
      const code = generateCode({ strength })
      const m = code.match(CODE_REGEX)
      assert.ok(m, `format invalide : ${code}`)
      const words = m[1].split('-')
      assert.strictEqual(words.length, n, `${strength} → ${n} mot(s)`)
      for (const w of words) assert.ok(WORDS.includes(w))
      // Aller-retour de normalisation (saisie avec espaces / minuscules).
      assert.strictEqual(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code)
    }
  }
  // 4 mots est plafonné à 3 ; 0 est ramené à 1.
  assert.strictEqual(generateCode({ words: 9 }).split('-').length, 4) // 3 mots + chiffres
  assert.strictEqual(generateCode({ words: 0 }).split('-').length, 2) // 1 mot + chiffres
})

test('code.js : passphrase modifie les secrets, et reste déterministe', async () => {
  const base = await deriveSecrets('TIGRE-7342')
  const withPass = await deriveSecrets('TIGRE-7342', 'mon secret')
  const withPass2 = await deriveSecrets('TIGRE-7342', 'mon secret')
  const otherPass = await deriveSecrets('TIGRE-7342', 'autre')
  // Le topic ET la clé d'auth dépendent de la passphrase.
  assert.notStrictEqual(base.topic.toString('hex'), withPass.topic.toString('hex'))
  assert.notStrictEqual(base.authKey.toString('hex'), withPass.authKey.toString('hex'))
  assert.notStrictEqual(withPass.authKey.toString('hex'), otherPass.authKey.toString('hex'))
  // Même code + même passphrase → mêmes secrets (sinon les pairs divergent).
  assert.strictEqual(withPass.topic.toString('hex'), withPass2.topic.toString('hex'))
  assert.strictEqual(withPass.authKey.toString('hex'), withPass2.authKey.toString('hex'))
})

/* ------------------------- sanitizeFilename ----------------------- */

test('transfer.js : sanitizeFilename neutralise les chemins et noms hostiles', () => {
  assert.strictEqual(sanitizeFilename('../../../etc/passwd'), 'passwd')
  assert.strictEqual(sanitizeFilename('..\\..\\windows\\system32\\evil.dll'), 'evil.dll')
  assert.strictEqual(sanitizeFilename('a<b>c:d"e.txt'), 'a_b_c_d_e.txt')
  assert.strictEqual(sanitizeFilename('fichier normal - v2.txt'), 'fichier normal - v2.txt')
  assert.strictEqual(sanitizeFilename('CON.txt'), '_CON.txt')
  assert.strictEqual(sanitizeFilename('nul'), '_nul')
  assert.strictEqual(sanitizeFilename('fin de nom. . .'), 'fin de nom')
  assert.strictEqual(sanitizeFilename(''), 'fichier')
  assert.strictEqual(sanitizeFilename('..'), 'fichier')
  assert.strictEqual(sanitizeFilename('x y.txt'), 'x_y.txt')
  assert.ok(sanitizeFilename('a'.repeat(300) + '.txt').length <= 200)
})

/* ----------------------------- framing ---------------------------- */

test('transfer.js : FrameStream échange JSON et binaire, trames fragmentées', async () => {
  const [a, b] = await makeSocketPair()
  const fa = new FrameStream(a)
  const fb = new FrameStream(b)

  const gotJson = once(fb, 'json')
  fa.sendJson({ t: 'PING', value: 42, texte: 'héhé' })
  assert.deepStrictEqual(await gotJson, { t: 'PING', value: 42, texte: 'héhé' })

  const payload = crypto.randomBytes(CHUNK_SIZE)
  const gotChunk = once(fa, 'chunk')
  fb.sendChunk(payload)
  assert.strictEqual(Buffer.compare(await gotChunk, payload), 0)

  // Trame surdimensionnée → erreur propre, pas de crash.
  const gotErr = once(fb, 'error')
  const evil = Buffer.alloc(5)
  evil.writeUInt32BE(10 * 1024 * 1024, 0)
  a.write(evil)
  assert.ok((await gotErr) instanceof Error)

  fa.destroy(); fb.destroy()
})

/* --------------------------- challenge-réponse -------------------- */

test('swarm.js : authentification mutuelle réussie avec le même code', async () => {
  const [a, b] = await makeSocketPair()
  const { authKey } = await deriveSecrets('LOUP-1234')
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey, role: 'sender' }),
    authenticate(new FrameStream(b), { authKey, role: 'receiver' })
  ])
  assert.strictEqual(okA, true)
  assert.strictEqual(okB, true)
  a.destroy(); b.destroy()
})

test('swarm.js : un mauvais code est rejeté des deux côtés', async () => {
  const [a, b] = await makeSocketPair()
  const k1 = (await deriveSecrets('LOUP-1234')).authKey
  const k2 = (await deriveSecrets('LOUP-1235')).authKey
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey: k1, role: 'sender', timeout: 3000 }),
    authenticate(new FrameStream(b), { authKey: k2, role: 'receiver', timeout: 3000 })
  ])
  assert.strictEqual(okA, false)
  assert.strictEqual(okB, false)
  a.destroy(); b.destroy()
})

test('swarm.js : la réflexion du HELLO/rôle identique est rejetée', async () => {
  const [a, b] = await makeSocketPair()
  const { authKey } = await deriveSecrets('LOUP-1234')
  // Les deux se prétendent « sender » : aucun ne doit accepter l'autre.
  const [okA, okB] = await Promise.all([
    authenticate(new FrameStream(a), { authKey, role: 'sender', timeout: 3000 }),
    authenticate(new FrameStream(b), { authKey, role: 'sender', timeout: 3000 })
  ])
  assert.strictEqual(okA, false)
  assert.strictEqual(okB, false)
  a.destroy(); b.destroy()
})

/* ------------------------ transfert de bout en bout --------------- */

test('transfert : multi-fichiers complet avec vérification du hash', async () => {
  const f1 = await makeTempFile('petit.txt', 13, Buffer.from('Bonjour P2P !'))
  const f2 = await makeTempFile('moyen.bin', 3 * CHUNK_SIZE + 777)
  const destDir = path.join(tmpRoot, 'recu-multi')

  const { sender, receiver } = await makePair([f1, f2], { destDir })

  let offer = null
  receiver.on('offer', (o) => { offer = o })
  const progressEvents = []
  receiver.on('progress', (p) => progressEvents.push(p))

  const doneR = once(receiver, 'done')
  const doneS = once(sender, 'done')
  await sender.start()
  const [resR] = await Promise.all([doneR, doneS])

  assert.ok(offer, 'offre reçue')
  assert.strictEqual(offer.sender, 'PC-test')
  assert.strictEqual(offer.files.length, 2)
  assert.ok(offer.files[0].sha256, 'hash pré-calculé pour les petits fichiers')

  assert.strictEqual(resR.files.length, 2)
  for (let i = 0; i < 2; i++) {
    const src = [f1, f2][i]
    const dst = resR.files[i].path
    assert.strictEqual(await hashFile(dst), await hashFile(src), 'contenu identique')
  }
  assert.ok(progressEvents.length > 0, 'événements de progression émis')
  const last = progressEvents[progressEvents.length - 1]
  assert.strictEqual(last.totalBytes, 13 + 3 * CHUNK_SIZE + 777)
  // Aucun .part résiduel.
  const leftovers = (await fsp.readdir(destDir)).filter((n) => n.endsWith('.part'))
  assert.deepStrictEqual(leftovers, [])
})

test('transfer.js : sanitizeRelPath neutralise « .. » et garde l\'arborescence', () => {
  assert.strictEqual(sanitizeRelPath('photos/2024/a.jpg'), path.join('photos', '2024', 'a.jpg'))
  assert.strictEqual(sanitizeRelPath('a/../../../etc/passwd'), path.join('a', 'etc', 'passwd'))
  assert.strictEqual(sanitizeRelPath('a\\b\\c.txt'), path.join('a', 'b', 'c.txt'))
  assert.strictEqual(sanitizeRelPath('./x/./y'), path.join('x', 'y'))
  assert.strictEqual(sanitizeRelPath('../..'), null)
  assert.strictEqual(sanitizeRelPath(''), null)
})

test('transfert : dossier complet → arborescence recréée et vérifiée', async () => {
  // Arborescence source : mondossier/{a.txt, sous/b.bin, sous/c.txt}
  const root = path.join(tmpRoot, 'mondossier')
  await fsp.mkdir(path.join(root, 'sous'), { recursive: true })
  await fsp.writeFile(path.join(root, 'a.txt'), 'fichier A')
  await makeTempFile(path.join('mondossier', 'sous', 'b.bin'), 2 * CHUNK_SIZE + 5)
  await fsp.writeFile(path.join(root, 'sous', 'c.txt'), 'fichier C')

  const entries = [
    { path: path.join(root, 'a.txt'), relPath: 'mondossier/a.txt' },
    { path: path.join(root, 'sous', 'b.bin'), relPath: 'mondossier/sous/b.bin' },
    { path: path.join(root, 'sous', 'c.txt'), relPath: 'mondossier/sous/c.txt' }
  ]
  const destDir = path.join(tmpRoot, 'recu-dossier')

  let offer = null
  const { sender, receiver } = await makePair(entries, { destDir })
  receiver.on('offer', (o) => { offer = o })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(offer.folder, true, "l'offre est marquée comme dossier")
  assert.strictEqual(res.files.length, 3)
  // Les trois fichiers existent sous mondossier/ avec le bon contenu.
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'mondossier', 'a.txt'), 'utf8'), 'fichier A')
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'mondossier', 'sous', 'c.txt'), 'utf8'), 'fichier C')
  assert.strictEqual(
    await hashFile(path.join(destDir, 'mondossier', 'sous', 'b.bin')),
    await hashFile(path.join(root, 'sous', 'b.bin'))
  )
})

test('transfert : un dossier reçu dont le nom existe déjà → racine suffixée', async () => {
  const root = path.join(tmpRoot, 'docs')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'x.txt'), 'X')
  await fsp.writeFile(path.join(root, 'y.txt'), 'Y')
  const destDir = path.join(tmpRoot, 'recu-dossier-collision')
  await fsp.mkdir(path.join(destDir, 'docs'), { recursive: true }) // occupe « docs »

  const entries = [
    { path: path.join(root, 'x.txt'), relPath: 'docs/x.txt' },
    { path: path.join(root, 'y.txt'), relPath: 'docs/y.txt' }
  ]
  const { sender, receiver } = await makePair(entries, { destDir })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  // Toute l'arborescence reçue est regroupée sous « docs (1) ».
  for (const f of res.files) {
    assert.ok(f.path.includes(`docs (1)${path.sep}`), `attendu sous docs (1) : ${f.path}`)
  }
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'docs (1)', 'x.txt'), 'utf8'), 'X')
})

test('sécurité : une OFFER avec des identifiants dupliqués est rejetée', async () => {
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
  // Expéditeur malveillant : deux fichiers avec id:0.
  framesA.sendJson({
    t: 'OFFER',
    sender: 'attaquant',
    files: [
      { id: 0, name: 'a.txt', size: 1, sha256: null },
      { id: 0, name: 'b.txt', size: 1, sha256: null }
    ]
  })
  const err = await errP
  assert.match(err.message, /dupliqu/i)
  a.destroy(); b.destroy()
})

test('robustesse : dispose() ne fait pas planter sur une fermeture en plein transfert', async () => {
  const src = await makeTempFile('dispose.bin', 30 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recu-dispose')
  const { sender, receiver, framesA, framesB } = await makePair([src], { destDir })

  await new Promise((resolve) => {
    receiver.once('progress', resolve)
    sender.start()
  })
  // Simule le démantèlement de session (fermeture de l'app) : on neutralise
  // les transferts AVANT de détruire les sockets — aucun 'error' non géré.
  await receiver.dispose()
  sender.dispose()
  framesA.destroy()
  framesB.destroy()
  await new Promise((r) => setTimeout(r, 150))
  const leftover = fs.existsSync(destDir)
    ? (await fsp.readdir(destDir)).filter((n) => n.endsWith('.part'))
    : []
  assert.deepStrictEqual(leftover, [], '.part nettoyé par dispose()')
})

test('transfert : collision de nom → « fichier (1).ext »', async () => {
  const src = await makeTempFile('collision.txt', 20)
  const destDir = path.join(tmpRoot, 'recu-collision')
  await fsp.mkdir(destDir, { recursive: true })
  await fsp.writeFile(path.join(destDir, 'collision.txt'), 'déjà là')

  const { sender, receiver } = await makePair([src], { destDir })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(path.basename(res.files[0].path), 'collision (1).txt')
  assert.strictEqual(await fsp.readFile(path.join(destDir, 'collision.txt'), 'utf8'), 'déjà là')
})

test('transfert : rien n\'est écrit avant l\'acceptation, REJECT propre', async () => {
  const src = await makeTempFile('prive.txt', 100)
  const destDir = path.join(tmpRoot, 'recu-reject')

  const { sender, receiver } = await makePair([src], { autoAccept: false })
  const offerP = once(receiver, 'offer')
  const rejectedP = once(sender, 'rejected')
  sender.start()
  await offerP
  // L'offre est arrivée mais rien ne doit exister sur le disque.
  assert.strictEqual(fs.existsSync(destDir), false)
  receiver.reject()
  await rejectedP
  assert.strictEqual(fs.existsSync(destDir), false)
})

test('transfert : fichier corrompu en transit → rejeté, .part supprimé', async () => {
  const src = await makeTempFile('corrompu.bin', 5 * CHUNK_SIZE)
  const destDir = path.join(tmpRoot, 'recu-corrompu')

  const { sender, receiver, framesA } = await makePair([src], { destDir })

  // Corrompt le 2e chunk en transit (l'expéditeur hash les données saines).
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

  assert.match(eR.message, /corrompu/i)
  assert.match(eS.message, /rejeté/i)
  const files = fs.existsSync(destDir) ? await fsp.readdir(destDir) : []
  assert.deepStrictEqual(files, [], 'le .part corrompu doit être supprimé')
})

test('transfert : coupure de connexion en plein transfert → erreur + nettoyage', async () => {
  const src = await makeTempFile('coupe.bin', 50 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recu-coupe')

  const { sender, receiver, socketA } = await makePair([src], { destDir })

  const errR = once(receiver, 'error')
  const errS = once(sender, 'error') // l'expéditeur doit aussi voir l'erreur
  receiver.once('progress', () => socketA.destroy()) // coupe brutalement
  sender.start()
  const [eR, eS] = await Promise.all([errR, errS])

  assert.match(eR.message, /perdue/i)
  assert.match(eS.message, /perdue/i)
  await new Promise((r) => setTimeout(r, 100)) // laisse le nettoyage finir
  const files = fs.existsSync(destDir) ? await fsp.readdir(destDir) : []
  assert.deepStrictEqual(files.filter((n) => n.endsWith('.part')), [], '.part nettoyé')
})

test('transfert : annulation par le destinataire pendant le transfert', async () => {
  const src = await makeTempFile('annule.bin', 50 * 1024 * 1024)
  const destDir = path.join(tmpRoot, 'recu-annule')

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
  assert.deepStrictEqual(files.filter((n) => n.endsWith('.part')), [], '.part nettoyé')
})

test('transfert : gros fichier en streaming, RAM bornée (< 200 Mo)', async function () {
  // 300 Mo suffisent à prouver le streaming : la consommation ne dépend
  // pas de la taille (chunks de 64 Ko + backpressure des deux côtés).
  const size = 300 * 1024 * 1024
  const src = await makeTempFile('gros.bin', size)
  const destDir = path.join(tmpRoot, 'recu-gros')

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

  const deltaMo = (rssPeak - rssBefore) / (1024 * 1024)
  assert.ok(deltaMo < 200, `pic mémoire : +${deltaMo.toFixed(0)} Mo (limite 200)`)
  const st = await fsp.stat(res.files[0].path)
  assert.strictEqual(st.size, size)
  assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
})

test('transfer.js : shouldCompress ne vise que les formats compressibles', () => {
  assert.strictEqual(shouldCompress('rapport.txt', 100000), true)
  assert.strictEqual(shouldCompress('data.json', 5000), true)
  assert.strictEqual(shouldCompress('petit.txt', 100), false) // sous le plancher
  assert.strictEqual(shouldCompress('photo.jpg', 5_000_000), false) // déjà compressé
  assert.strictEqual(shouldCompress('archive.zip', 5_000_000), false)
  assert.strictEqual(shouldCompress('film.mp4', 50_000_000), false)
})

test('transfert : compression à la volée, intégrité préservée', async () => {
  // 2 Mo de texte répétitif → fortement compressible.
  const text = Buffer.from('NeoDrop pair-à-pair, compression brotli en transport. ')
  const src = await makeTempFile('gros.txt', 2 * 1024 * 1024, text)
  const destDir = path.join(tmpRoot, 'recu-compress')

  const { sender, receiver } = await makePair([src], { destDir, compression: true })
  let offer = null
  receiver.on('offer', (o) => { offer = o })
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(offer.compression, true, "l'offre annonce la compression")
  // Le fichier reçu est identique à l'original (hash sur les données d'origine).
  assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
  const st = await fsp.stat(res.files[0].path)
  assert.strictEqual(st.size, 2 * 1024 * 1024)
})

test('transfert : pipeline de nombreux petits fichiers', async () => {
  const entries = []
  for (let i = 0; i < 25; i++) {
    const p = await makeTempFile(`p${i}.dat`, 1500 + i, Buffer.from(`fichier numero ${i} `))
    entries.push({ path: p, relPath: `lot/p${i}.dat` })
  }
  const destDir = path.join(tmpRoot, 'recu-pipeline')
  const { sender, receiver } = await makePair(entries, { destDir })
  const doneEvents = []
  receiver.on('file-done', (f) => doneEvents.push(f))
  const doneR = once(receiver, 'done')
  await sender.start()
  const res = await doneR

  assert.strictEqual(res.files.length, 25)
  assert.strictEqual(doneEvents.length, 25, 'un file-done par fichier')
  for (let i = 0; i < 25; i++) {
    const dst = path.join(destDir, 'lot', `p${i}.dat`)
    assert.strictEqual(await hashFile(dst), await hashFile(entries[i].path))
  }
})

test('transfert : reprise après coupure via le cache de reprise', async () => {
  const size = 24 * 1024 * 1024
  const src = await makeTempFile('reprise.bin', size)
  const destDir = path.join(tmpRoot, 'recu-reprise')
  const resumeDir = path.join(tmpRoot, 'cache-reprise')

  // 1re tentative : on coupe la connexion en plein transfert (compression
  // désactivée pour que l'offset sur disque corresponde simplement aux octets).
  // Coupure déterministe au 40e chunk (≈ 2,5 Mo sur 24) : ne dépend pas de la
  // vitesse de la boucle locale, qui peut sinon terminer avant la coupure.
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

  // Le partiel doit avoir été CONSERVÉ dans le cache de reprise.
  const partials = (await fsp.readdir(resumeDir)).filter((n) => n.endsWith('.part'))
  assert.strictEqual(partials.length, 1, 'un fichier partiel conservé pour la reprise')
  const partialBytes = (await fsp.stat(path.join(resumeDir, partials[0]))).size
  assert.ok(partialBytes > 0 && partialBytes < size, `partiel non trivial : ${partialBytes}`)

  // 2e tentative : même entrée, même cache → reprise puis complétion.
  {
    const { sender, receiver } = await makePair([src], { destDir, resumeDir, compression: false })
    let resumeAnnounced = null
    receiver.on('offer', async () => {
      await receiver.accept(destDir)
    })
    // Capte la valeur de reprise envoyée à l'expéditeur.
    const origStart = sender._streamFile.bind(sender)
    sender._streamFile = (fp, meta, prog, opts) => {
      resumeAnnounced = opts.startOffset
      return origStart(fp, meta, prog, opts)
    }
    const doneR = once(receiver, 'done')
    await sender.start()
    const res = await doneR

    assert.ok(resumeAnnounced > 0, `la reprise a démarré à un offset > 0 (vu ${resumeAnnounced})`)
    assert.strictEqual(await hashFile(res.files[0].path), await hashFile(src))
    // Le cache de reprise est vidé une fois le fichier complété.
    const left = (await fsp.readdir(resumeDir)).filter((n) => n.endsWith('.part'))
    assert.deepStrictEqual(left, [], 'cache de reprise nettoyé après complétion')
  }
})

/* --------------- bout en bout via Hyperswarm (DHT locale) ---------- */

// Le sandbox de test se comporte comme un réseau 100 % loopback : on
// injecte des nœuds DHT non-firewalled (sinon hyperdht tente un
// holepunch impossible entre deux pairs « derrière NAT » fictifs).
function localDhtOpts (testnet) {
  const HyperDHT = require('hyperdht')
  return { dht: new HyperDHT({ bootstrap: testnet.bootstrap, firewalled: false }) }
}

test('hyperswarm : découverte + auth + transfert complet via DHT locale', async () => {
  const createTestnet = require('hyperdht/testnet')
  const { SwarmSession } = require('../src/main/swarm')
  const testnet = await createTestnet(3)

  const src = await makeTempFile('via-dht.bin', 2 * CHUNK_SIZE + 123)
  const destDir = path.join(tmpRoot, 'recu-dht')
  const code = generateCode()

  const sSender = new SwarmSession({ code, role: 'sender', swarmOpts: localDhtOpts(testnet) })
  const sReceiver = new SwarmSession({ code, role: 'receiver', swarmOpts: localDhtOpts(testnet) })

  try {
    const authS = once(sSender, 'peer-authenticated')
    const authR = once(sReceiver, 'peer-authenticated')
    await sSender.start()
    await sSender.flushed() // l'annonce doit être propagée avant le lookup
    await sReceiver.start()
    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('pas de pair authentifié en 30 s')), 30000))
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

test('hyperswarm : un mauvais code ne donne jamais accès, 3 échecs → invalidation', async () => {
  const createTestnet = require('hyperdht/testnet')
  const HyperDHT = require('hyperdht')
  const { SwarmSession, authenticate: auth } = require('../src/main/swarm')
  const testnet = await createTestnet(3)

  const code = generateCode()
  const sSender = new SwarmSession({ code, role: 'sender', swarmOpts: localDhtOpts(testnet) })

  // L'attaquant a observé le topic sur la DHT mais ne connaît pas le
  // code : sa clé d'auth est dérivée d'un autre code.
  const { topic } = await deriveSecrets(code)
  const badKey = (await deriveSecrets('FAUX-0000')).authKey
  const attackerNode = new HyperDHT({ bootstrap: testnet.bootstrap, firewalled: false })

  try {
    const invalidated = once(sSender, 'invalidated')
    const failures = []
    sSender.on('auth-failed', (f) => failures.push(f))

    await sSender.start()
    await sSender.flushed()

    // Retrouve la clé publique de l'expéditeur annoncée sur le topic.
    let peerKey = null
    for await (const entry of attackerNode.lookup(topic)) {
      if (entry.peers && entry.peers.length > 0) { peerKey = entry.peers[0].publicKey; break }
    }
    assert.ok(peerKey, 'pair annoncé visible sur la DHT')

    // 3 tentatives avec un mauvais code : toutes doivent échouer.
    for (let i = 0; i < 3; i++) {
      const socket = attackerNode.connect(peerKey)
      socket.on('error', () => {})
      const ok = await auth(new FrameStream(socket), { authKey: badKey, role: 'receiver', timeout: 8000 })
      assert.strictEqual(ok, false, "l'attaquant ne doit jamais être authentifié")
      socket.destroy()
    }

    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('pas d\'invalidation en 30 s')), 30000))
    await Promise.race([invalidated, guard])

    assert.ok(failures.length >= 3, `3 échecs attendus, vu ${failures.length}`)
    assert.strictEqual(sSender.closed, true, 'le code invalidé ferme la session')
  } finally {
    await sSender.close()
    await attackerNode.destroy()
    await testnet.destroy()
  }
})

/* -------------------- DHT réelle (opt-in, réseau requis) ----------- */

if (process.env.NEODROP_TEST_DHT === '1') {
  test('DHT : deux SwarmSession se trouvent et s\'authentifient via Hyperswarm', async () => {
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
        setTimeout(() => rej(new Error('pas de pair en 60 s (réseau restreint ?)')), 60000))
      await Promise.race([Promise.all([authSender, authReceiver]), timeout])
    } finally {
      await sSender.close()
      await sReceiver.close()
    }
  })
}

run()
