'use strict'

// NeoDrop UI logic. No network/disk access here: everything goes through
// window.api (preload) and the "session-event" events.

const $ = (id) => document.getElementById(id)

function showScreen (id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'))
  $(id).classList.add('active')
}

function renderFileList (container, files) {
  container.innerHTML = ''
  for (const f of files) {
    const row = document.createElement('div')
    row.className = 'file-row'

    const wrap = document.createElement('div')
    wrap.className = 'name-wrap'
    if (f.thumb) {
      const img = document.createElement('img')
      img.className = 'thumb'
      img.src = f.thumb
      img.alt = ''
      wrap.appendChild(img)
    }
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = f.relPath || f.name
    wrap.appendChild(name)

    const size = document.createElement('span')
    size.className = 'size'
    size.textContent = formatBytes(f.size)
    row.append(wrap, size)
    container.appendChild(row)
  }
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`
}

function formatSpeed (bytesPerSec) {
  if (!bytesPerSec) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

function formatEta (seconds) {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds} s left`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m} min ${String(s).padStart(2, '0')} left`
  return `${Math.floor(m / 60)} h ${m % 60} min left`
}

let role = null
let currentOffer = null
let destDir = null
let receivedFiles = []
let expiryTimer = null
let connectionType = null

function resetState () {
  role = null
  currentOffer = null
  destDir = null
  receivedFiles = []
  connectionType = null
  stopExpiryCountdown()
}

function goHome () {
  window.api.cancel()
  resetState()
  $('code-input').value = ''
  $('recv-pass').value = ''
  $('receive-status').classList.add('hidden')
  $('btn-cancel-receive').classList.add('hidden')
  $('btn-connect').disabled = false
  $('conn-badge').classList.add('hidden')
  $('qr-code').classList.add('hidden')
  $('pass-reminder').classList.add('hidden')
  $('progress-fill').style.width = '0%'
  showScreen('screen-home')
}

$('btn-go-send').addEventListener('click', () => { role = 'sender'; showScreen('screen-send') })
$('btn-go-receive').addEventListener('click', async () => {
  role = 'receiver'
  showScreen('screen-receive')
  if (!$('code-input').value) {
    try {
      const text = await window.api.readClipboard()
      if (text && /^[A-Za-z]{2,12}([ -][A-Za-z]{2,12}){0,2}[ -]?\d{4}$/.test(text.trim())) {
        $('code-input').value = text.trim()
      }
    } catch {}
  }
  $('code-input').focus()
})
$('btn-go-history').addEventListener('click', showHistory)
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goHome))
$('btn-done-home').addEventListener('click', goHome)
$('btn-error-home').addEventListener('click', goHome)
$('btn-cancel-wait').addEventListener('click', goHome)
$('btn-cancel-transfer').addEventListener('click', goHome)
$('btn-cancel-receive').addEventListener('click', goHome)

function showError (message) {
  $('error-text').textContent = message
  showScreen('screen-error')
}

function formatDate (ts) {
  try {
    return new Date(ts).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return '' }
}

async function showHistory () {
  const list = await window.api.getHistory().catch(() => [])
  const container = $('history-list')
  container.innerHTML = ''
  $('history-empty').classList.toggle('hidden', list.length > 0)
  for (const h of list) {
    const item = document.createElement('div')
    item.className = 'history-item'
    const dir = h.direction === 'send' ? 'Sent' : 'Received'
    const names = (h.names || []).join(', ') + (h.count > (h.names || []).length ? '…' : '')
    const top = document.createElement('div')
    top.className = 'h-top'
    const d = document.createElement('span')
    d.className = `h-dir ${h.direction}`
    d.textContent = `${h.direction === 'send' ? '↑' : '↓'} ${dir} · ${h.count} file(s) · ${formatBytes(h.totalSize)}`
    const when = document.createElement('span')
    when.className = 'h-when'
    when.textContent = formatDate(h.at)
    top.append(d, when)
    const files = document.createElement('div')
    files.className = 'h-files'
    files.textContent = names
    item.append(top, files)
    container.appendChild(item)
  }
  showScreen('screen-history')
}

$('btn-clear-history').addEventListener('click', async () => {
  await window.api.clearHistory().catch(() => {})
  showHistory()
})

/* send */

const dropZone = $('drop-zone')

dropZone.addEventListener('click', () => browseAndSend())
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter') browseAndSend() })
$('btn-browse').addEventListener('click', (e) => { e.stopPropagation(); browseAndSend() })
$('btn-browse-folder').addEventListener('click', (e) => { e.stopPropagation(); browseFolderAndSend() })

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('dragover')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('dragover')
  const paths = [...e.dataTransfer.files]
    .map((f) => window.api.getFilePath(f))
    .filter(Boolean)
  if (paths.length > 0) startSending(paths)
})

async function browseAndSend () {
  const paths = await window.api.chooseFiles()
  if (paths.length > 0) startSending(paths)
}

async function browseFolderAndSend () {
  const paths = await window.api.chooseFolder()
  if (paths.length > 0) startSending(paths)
}

function readSendOptions () {
  const limit = Number($('opt-limit').value)
  return {
    strength: $('opt-strength').value || 'normal',
    passphrase: $('opt-pass').value || '',
    compression: $('opt-compress').checked,
    rateLimit: Number.isFinite(limit) && limit > 0 ? Math.round(limit * 1024 * 1024) : 0
  }
}

async function startSending (paths) {
  role = 'sender'
  $('wait-status').textContent = 'Preparing…'
  const res = await window.api.startSend(paths, readSendOptions())
  if (res.error) return showError(res.error)

  $('pairing-code').textContent = res.code
  $('wait-status').textContent = 'Waiting for the recipient…'
  const qr = $('qr-code')
  if (res.qr) { qr.src = res.qr; qr.classList.remove('hidden') } else { qr.classList.add('hidden') }
  $('pass-reminder').classList.toggle('hidden', !res.passphrase)
  renderFileList($('wait-files'), res.files || [])
  if (res.folder) {
    const n = (res.files || []).length
    $('wait-files').insertAdjacentHTML('afterbegin',
      `<div class="file-row"><span class="name">📁 Folder — ${n} file(s)</span></div>`)
  }
  startExpiryCountdown(res.expiresAt)
  showScreen('screen-wait')
}

$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pairing-code').textContent)
    $('btn-copy').textContent = 'Copied ✓'
    setTimeout(() => { $('btn-copy').textContent = 'Copy' }, 1500)
  } catch {}
})

function startExpiryCountdown (expiresAt) {
  stopExpiryCountdown()
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now())
    const m = Math.floor(left / 60000)
    const s = Math.floor((left % 60000) / 1000)
    $('code-expiry').textContent = `Expires in ${m} min ${String(s).padStart(2, '0')} s`
    if (left <= 0) stopExpiryCountdown()
  }
  tick()
  expiryTimer = setInterval(tick, 1000)
}

function stopExpiryCountdown () {
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null }
  $('code-expiry').textContent = ''
}

/* receive */

$('btn-connect').addEventListener('click', connect)
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect() })

async function connect () {
  const code = $('code-input').value
  if (!code.trim()) return
  role = 'receiver'
  $('btn-connect').disabled = true
  $('receive-status').classList.remove('hidden')
  $('btn-cancel-receive').classList.remove('hidden')
  $('receive-status-text').textContent = 'Looking for the sender…'

  const res = await window.api.startReceive(code, { passphrase: $('recv-pass').value || '' })
  if (res.error) {
    $('btn-connect').disabled = false
    $('receive-status').classList.add('hidden')
    $('btn-cancel-receive').classList.add('hidden')
    showError(res.error)
  }
}

$('btn-change-dir').addEventListener('click', async () => {
  const dir = await window.api.chooseDir()
  if (dir) {
    destDir = dir
    $('dest-dir').textContent = dir
  }
})

$('btn-accept').addEventListener('click', async () => {
  $('btn-accept').disabled = true
  $('btn-reject').disabled = true
  await window.api.accept(destDir)
  $('progress-title').textContent = 'Receiving…'
  $('progress-fill').style.width = '0%'
  showScreen('screen-progress')
  showConnBadge()
})

$('btn-reject').addEventListener('click', async () => {
  await window.api.reject()
  goHome()
})

$('btn-open-folder').addEventListener('click', () => {
  if (receivedFiles.length > 0) window.api.showInFolder(receivedFiles[0].path)
})

function showConnBadge () {
  if (connectionType) {
    $('conn-badge').textContent = `${connectionType} encrypted connection`
    $('conn-badge').classList.remove('hidden')
  } else {
    $('conn-badge').classList.add('hidden')
  }
}

window.api.onEvent(({ type, data }) => {
  switch (type) {
    case 'peer-connected':
      if (role === 'sender') $('wait-status').textContent = 'Peer found, checking the code…'
      else $('receive-status-text').textContent = 'Sender found, checking the code…'
      break

    case 'peer-authenticated':
      connectionType = data.connectionType
      if (role === 'sender') $('wait-status').textContent = 'Recipient connected ✓'
      else $('receive-status-text').textContent = 'Connected ✓ Waiting for details…'
      break

    case 'progress': {
      const pct = data.totalSize > 0 ? Math.floor((data.totalBytes / data.totalSize) * 100) : 0
      $('progress-pct').textContent = `${pct} %`
      $('progress-fill').style.width = `${pct}%`
      $('progress-file').textContent =
        data.fileCount > 1
          ? `File ${data.fileIndex + 1}/${data.fileCount}: ${data.fileName}`
          : data.fileName
      $('progress-speed').textContent = formatSpeed(data.speed)
      $('progress-eta').textContent = formatEta(data.eta)
      $('progress-global').textContent =
        `${formatBytes(data.totalBytes)} of ${formatBytes(data.totalSize)}`
      break
    }

    case 'done':
      receivedFiles = (data && data.files) || []
      $('done-title').textContent = 'Transfer complete'
      if (role === 'receiver') {
        $('done-text').textContent = 'Integrity verified (SHA-256). Files saved:'
        renderFileList($('done-files'), receivedFiles)
        $('btn-open-folder').classList.toggle('hidden', receivedFiles.length === 0)
      } else {
        $('done-text').textContent = 'The recipient received all files. Integrity verified.'
        $('done-files').innerHTML = ''
        $('btn-open-folder').classList.add('hidden')
      }
      showScreen('screen-done')
      break

    case 'cancelled':
      if (data && data.rejected) break
      if (data && data.by === 'peer') {
        showError(role === 'sender'
          ? 'The recipient cancelled or declined the transfer.'
          : 'The sender cancelled the transfer.')
      } else {
        goHome()
      }
      break

    case 'error':
      showError(data.message || 'An unexpected error occurred.')
      break

    case 'auth-failed':
      $('wait-status').textContent =
        `Wrong code received (${data.failures}/3). ${data.remaining} attempt(s) left before invalidation.`
      break

    case 'code-invalidated':
      showError('Too many wrong-code attempts: this code is now invalid. Generate a new one.')
      break

    case 'code-expired':
      showError('The code expired (15 minutes with no connection). Generate a new one.')
      break

    case 'waiting-confirmation':
      $('wait-status').textContent = 'Waiting for the recipient to confirm…'
      break

    case 'transfer-started':
      $('progress-title').textContent = 'Sending…'
      $('progress-fill').style.width = '0%'
      showScreen('screen-progress')
      showConnBadge()
      break

    case 'rejected':
      showError('The recipient declined the transfer.')
      break

    case 'connect-timeout':
      showError('Could not find the sender within 30 seconds. Check the code and your internet connection, then try again.')
      break

    case 'auth-failed-receiver':
      showError('This code does not match. Check it with the sender.')
      break

    case 'offer': {
      currentOffer = data
      destDir = data.defaultDir
      const total = data.files.reduce((a, f) => a + f.size, 0)
      let fileDesc
      if (data.folder) {
        fileDesc = `a folder (${data.files.length} file(s), ${formatBytes(total)})`
      } else if (data.files.length === 1) {
        fileDesc = `"${data.files[0].name}" (${formatBytes(total)})`
      } else {
        fileDesc = `${data.files.length} files (${formatBytes(total)})`
      }
      $('confirm-text').innerHTML = ''
      const strong = document.createElement('strong')
      strong.textContent = data.sender
      $('confirm-text').append(strong, ` wants to send you ${fileDesc}.`)
      renderFileList($('confirm-files'), data.files)
      $('dest-dir').textContent = destDir
      $('btn-accept').disabled = false
      $('btn-reject').disabled = false
      showScreen('screen-confirm')
      break
    }

    case 'file-done':
      break
  }
})
