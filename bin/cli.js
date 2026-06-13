#!/usr/bin/env node
'use strict'

/**
 * NeoDrop en ligne de commande — même cœur P2P que l'application, sans
 * interface Electron. Pratique pour les scripts et les machines sans bureau.
 *
 *   neodrop send <fichier|dossier>...  [--pass PHRASE] [--strength high|max]
 *                                      [--no-compress] [--limit Mo/s]
 *   neodrop receive <CODE> [--out DOSSIER] [--pass PHRASE] [--yes]
 *
 * Le transfert reste chiffré de bout en bout et vérifié par SHA-256.
 */

const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const readline = require('readline')

const { normalizeCode } = require('../src/main/code')
const { SwarmSession } = require('../src/main/swarm')
const { TransferSender, TransferReceiver, cleanupAllPartFiles } = require('../src/main/transfer')

const MAX_FILES = 5000

function parseArgs (argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-compress') flags.compress = false
    else if (a === '--yes' || a === '-y') flags.yes = true
    else if (a === '--pass') flags.pass = argv[++i]
    else if (a === '--strength') flags.strength = argv[++i]
    else if (a === '--out' || a === '-o') flags.out = argv[++i]
    else if (a === '--limit') flags.limit = Number(argv[++i])
    else positional.push(a)
  }
  return { positional, flags }
}

async function expandEntries (paths) {
  const entries = []
  const walk = async (dir, rel) => {
    for (const it of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entries.length > MAX_FILES) return
      const full = path.join(dir, it.name)
      if (it.isDirectory()) await walk(full, `${rel}/${it.name}`)
      else if (it.isFile()) entries.push({ path: full, relPath: `${rel}/${it.name}` })
    }
  }
  for (const p of paths) {
    const st = await fsp.stat(p)
    if (st.isFile()) entries.push({ path: p, relPath: path.basename(p) })
    else if (st.isDirectory()) await walk(p, path.basename(p))
  }
  if (entries.length === 0) throw new Error('Aucun fichier à envoyer.')
  return entries
}

function fmtBytes (n) {
  if (n < 1024) return `${n} o`
  const u = ['Ko', 'Mo', 'Go', 'To']; let v = n; let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < u.length - 1)
  return `${v.toFixed(1)} ${u[i]}`
}

function progressBar (p) {
  const pct = p.totalSize > 0 ? p.totalBytes / p.totalSize : 0
  const width = 28
  const filled = Math.round(pct * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const speed = p.speed ? `${fmtBytes(p.speed)}/s` : ''
  const line = `  [${bar}] ${(pct * 100).toFixed(0).padStart(3)} %  ${fmtBytes(p.totalBytes)}/${fmtBytes(p.totalSize)}  ${speed}   `
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(line)
}

function ask (question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

function resumeDir () {
  return path.join(os.homedir(), '.neodrop', 'partials')
}

async function doSend (paths, flags) {
  const entries = await expandEntries(paths)
  const total = (await Promise.all(entries.map((e) => fsp.stat(e.path)))).reduce((a, s) => a + s.size, 0)
  const { generateCode } = require('../src/main/code')
  const code = generateCode({ strength: flags.strength || 'normal' })
  const passphrase = flags.pass || ''

  const session = new SwarmSession({ code, role: 'sender', passphrase })
  let done = false
  const finish = async (codeNum, msg) => {
    if (done) return; done = true
    if (msg) { process.stdout.write('\n' + msg + '\n') }
    await session.close().catch(() => {})
    await cleanupAllPartFiles().catch(() => {})
    process.exit(codeNum)
  }

  session.on('expired', () => finish(1, 'Code expiré (15 min sans connexion).'))
  session.on('invalidated', () => finish(1, 'Code invalidé (3 tentatives erronées).'))
  session.on('error', (e) => finish(1, 'Erreur : ' + e.message))
  session.on('peer-authenticated', ({ frames, connectionType }) => {
    process.stdout.write(`\nDestinataire connecté (connexion ${connectionType || 'directe'}).\n`)
    const sender = new TransferSender(frames, entries, {
      senderName: os.hostname(),
      compression: flags.compress !== false,
      rateLimit: flags.limit > 0 ? Math.round(flags.limit * 1024 * 1024) : 0
    })
    sender.on('progress', progressBar)
    sender.on('rejected', () => finish(1, 'Le destinataire a refusé.'))
    sender.on('cancelled', () => finish(1, 'Transfert annulé.'))
    sender.on('error', (e) => finish(1, 'Erreur : ' + e.message))
    sender.on('done', () => finish(0, 'Transfert terminé, intégrité vérifiée.'))
    sender.start()
  })

  await session.start()
  console.log(`\n  Code d'appairage :  ${code}`)
  if (passphrase) console.log('  (passphrase requise du côté destinataire)')
  console.log(`  ${entries.length} fichier(s), ${fmtBytes(total)}. En attente du destinataire…\n`)
}

async function doReceive (rawCode, flags) {
  const code = normalizeCode(rawCode)
  if (!code) throw new Error('Code invalide. Format attendu : MOT-1234.')
  const outDir = path.resolve(flags.out || process.cwd())
  const passphrase = flags.pass || ''

  const session = new SwarmSession({ code, role: 'receiver', passphrase })
  let done = false
  const finish = async (codeNum, msg) => {
    if (done) return; done = true
    if (msg) process.stdout.write('\n' + msg + '\n')
    await session.close().catch(() => {})
    process.exit(codeNum)
  }

  session.on('timeout', () => finish(1, "Expéditeur introuvable (30 s). Vérifie le code."))
  session.on('auth-failed', () => process.stdout.write('Code/passphrase incorrect, nouvelle tentative…\n'))
  session.on('error', (e) => finish(1, 'Erreur : ' + e.message))
  session.on('peer-authenticated', ({ frames }) => {
    const receiver = new TransferReceiver(frames, { resumeDir: resumeDir() })
    receiver.on('offer', async (offer) => {
      const total = offer.files.reduce((a, f) => a + f.size, 0)
      console.log(`\n${offer.sender} propose ${offer.files.length} fichier(s) (${fmtBytes(total)})` +
        (offer.folder ? ' [dossier]' : '') + ` → ${outDir}`)
      if (!flags.yes) {
        const a = (await ask('Accepter ? [o/N] ')).trim().toLowerCase()
        if (a !== 'o' && a !== 'oui' && a !== 'y') { receiver.reject(); return finish(0, 'Refusé.') }
      }
      await receiver.accept(outDir)
    })
    receiver.on('progress', progressBar)
    receiver.on('cancelled', () => finish(1, "L'expéditeur a annulé."))
    receiver.on('error', (e) => finish(1, 'Erreur : ' + e.message))
    receiver.on('done', ({ files }) => {
      let out = '\nReçu, intégrité vérifiée :\n'
      for (const f of files) out += `  • ${f.relPath || f.name}\n`
      // Petit délai avant de fermer : laisse le DONE_ACK parvenir à
      // l'expéditeur (sinon il signale une coupure au lieu d'un succès).
      setTimeout(() => finish(0, out), 1200)
    })
  })

  await session.start()
  console.log("Recherche de l'expéditeur…")
}

function usage () {
  console.log(`NeoDrop CLI — transfert de fichiers P2P chiffré

Usage :
  neodrop send <fichier|dossier>...  [--pass PHRASE] [--strength high|max]
                                     [--no-compress] [--limit Mo/s]
  neodrop receive <CODE> [--out DOSSIER] [--pass PHRASE] [--yes]
`)
}

async function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  try {
    if (cmd === 'send') {
      if (positional.length === 0) { usage(); process.exit(2) }
      await doSend(positional, flags)
    } else if (cmd === 'receive') {
      if (positional.length === 0) { usage(); process.exit(2) }
      await doReceive(positional[0], flags)
    } else {
      usage(); process.exit(cmd ? 2 : 0)
    }
  } catch (err) {
    console.error('Erreur :', err.message)
    process.exit(1)
  }
}

main()
