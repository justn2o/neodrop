#!/usr/bin/env node
'use strict'

// NeoDrop command line - same P2P core as the app, no Electron UI.
//
//   neodrop                              interactive menu
//   neodrop send <file|folder>...  [--pass PHRASE] [--strength high|max]
//                                  [--no-compress] [--limit MB/s]
//   neodrop receive <CODE> [--out DIR] [--pass PHRASE] [--yes]
//
// Transfers stay end-to-end encrypted and SHA-256 verified.

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
  if (entries.length === 0) throw new Error('No file to send.')
  return entries
}

function fmtBytes (n) {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n; let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < u.length - 1)
  return `${v.toFixed(1)} ${u[i]}`
}

function progressBar (p) {
  const pct = p.totalSize > 0 ? p.totalBytes / p.totalSize : 0
  const width = 28
  const filled = Math.round(pct * width)
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled)
  const speed = p.speed ? `${fmtBytes(p.speed)}/s` : ''
  const line = `  [${bar}] ${(pct * 100).toFixed(0).padStart(3)} %  ${fmtBytes(p.totalBytes)}/${fmtBytes(p.totalSize)}  ${speed}   `
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(line)
}

// Single reused readline interface (recreating one per prompt loses buffered
// lines on pasted/piped input).
let _rl = null
function ask (question) {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => _rl.question(question, resolve))
}
function closePrompts () { if (_rl) { _rl.close(); _rl = null } }

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

  session.on('expired', () => finish(1, 'Code expired (15 min with no connection).'))
  session.on('invalidated', () => finish(1, 'Code invalidated (3 wrong attempts).'))
  session.on('error', (e) => finish(1, 'Error: ' + e.message))
  session.on('peer-authenticated', ({ frames, connectionType }) => {
    process.stdout.write(`\nRecipient connected (${connectionType || 'direct'} connection).\n`)
    const sender = new TransferSender(frames, entries, {
      senderName: os.hostname(),
      compression: flags.compress !== false,
      rateLimit: flags.limit > 0 ? Math.round(flags.limit * 1024 * 1024) : 0
    })
    sender.on('progress', progressBar)
    sender.on('rejected', () => finish(1, 'The recipient declined.'))
    sender.on('cancelled', () => finish(1, 'Transfer cancelled.'))
    sender.on('error', (e) => finish(1, 'Error: ' + e.message))
    sender.on('done', () => finish(0, 'Transfer complete, integrity verified.'))
    sender.start()
  })

  await session.start()
  console.log(`\n  Pairing code:  ${code}`)
  if (passphrase) console.log('  (passphrase required on the recipient side)')
  console.log(`  ${entries.length} file(s), ${fmtBytes(total)}. Waiting for the recipient...\n`)
}

async function doReceive (rawCode, flags) {
  const code = normalizeCode(rawCode)
  if (!code) throw new Error('Invalid code. Expected format: WORD-1234.')
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

  session.on('timeout', () => finish(1, 'Sender not found (30s). Check the code.'))
  session.on('auth-failed', () => process.stdout.write('Wrong code/passphrase, retrying...\n'))
  session.on('error', (e) => finish(1, 'Error: ' + e.message))
  session.on('peer-authenticated', ({ frames }) => {
    const receiver = new TransferReceiver(frames, { resumeDir: resumeDir() })
    receiver.on('offer', async (offer) => {
      const total = offer.files.reduce((a, f) => a + f.size, 0)
      console.log(`\n${offer.sender} offers ${offer.files.length} file(s) (${fmtBytes(total)})` +
        (offer.folder ? ' [folder]' : '') + ` -> ${outDir}`)
      if (!flags.yes) {
        const a = (await ask('Accept? [y/N] ')).trim().toLowerCase()
        if (a !== 'y' && a !== 'yes') { receiver.reject(); return finish(0, 'Declined.') }
      }
      await receiver.accept(outDir)
    })
    receiver.on('progress', progressBar)
    receiver.on('cancelled', () => finish(1, 'The sender cancelled.'))
    receiver.on('error', (e) => finish(1, 'Error: ' + e.message))
    receiver.on('done', ({ files }) => {
      let out = '\nReceived, integrity verified:\n'
      for (const f of files) out += `  - ${f.relPath || f.name}\n`
      // Small delay before closing: let the DONE_ACK reach the sender.
      setTimeout(() => finish(0, out), 1200)
    })
  })

  await session.start()
  console.log('Looking for the sender...')
}

function usage () {
  console.log(`NeoDrop CLI - encrypted P2P file transfer

Usage:
  neodrop                          interactive menu (Send / Receive)
  neodrop send <file|folder>...  [--pass PHRASE] [--strength high|max]
                                 [--no-compress] [--limit MB/s]
  neodrop receive <CODE> [--out DIR] [--pass PHRASE] [--yes]
`)
}

function cleanPath (s) {
  return String(s).trim().replace(/^["']+|["']+$/g, '').trim()
}

async function interactive () {
  console.log('\n  NeoDrop - encrypted P2P file transfer\n')
  const choice = (await ask('  [1] Send    [2] Receive    [q] Quit\n  > ')).trim().toLowerCase()

  if (['1', 's', 'send'].includes(choice)) {
    let p = ''
    while (!p) p = cleanPath(await ask('\n  File or folder to send: '))
    const strong = (await ask('  Stronger code (2 words)? [y/N] ')).trim().toLowerCase()
    const pass = (await ask('  Passphrase (Enter for none): ')).trim()
    const flags = {}
    if (['y', 'yes'].includes(strong)) flags.strength = 'high'
    if (pass) flags.pass = pass
    closePrompts()
    console.log('')
    await doSend([p], flags)
  } else if (['2', 'r', 'receive'].includes(choice)) {
    let code = ''
    while (!code) code = (await ask('\n  Code received (e.g. TIGER-7342): ')).trim()
    const pass = (await ask('  Passphrase (Enter for none): ')).trim()
    const out = cleanPath(await ask('  Destination folder (Enter for current): ')) || process.cwd()
    const flags = { out, yes: true }
    if (pass) flags.pass = pass
    closePrompts()
    console.log('')
    await doReceive(code, flags)
  } else {
    process.exit(0)
  }
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
    } else if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
      usage(); process.exit(0)
    } else if (!cmd) {
      await interactive()
    } else {
      usage(); process.exit(2)
    }
  } catch (err) {
    console.error('Error:', err.message)
    process.exit(1)
  }
}

main()
