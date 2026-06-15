/**
 * NeoDrop mobile UI (React Native). All P2P logic runs in the embedded Node.js
 * backend (nodejs-assets/nodejs-project/main.js); this file only renders state
 * and sends high-level commands over the nodejs-mobile channel.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Platform, PermissionsAndroid
} from 'react-native'
import nodejs from 'nodejs-mobile-react-native'
import DocumentPicker from 'react-native-document-picker'
import RNFS from 'react-native-fs'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'

const ACCENT = '#2563eb'

const destDir = Platform.OS === 'android'
  ? RNFS.DownloadDirectoryPath + '/NeoDrop'
  : RNFS.DocumentDirectoryPath + '/NeoDrop'

function fmtBytes (n) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n; let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < u.length - 1)
  return `${v.toFixed(1)} ${u[i]}`
}

export default function App () {
  const [screen, setScreen] = useState('home') // home|send|wait|receive|confirm|progress|done|error
  const [code, setCode] = useState('')
  const [inputCode, setInputCode] = useState('')
  const [status, setStatus] = useState('')
  const [offer, setOffer] = useState(null)
  const [progress, setProgress] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [received, setReceived] = useState([])
  const role = useRef(null)

  const sendCmd = useCallback((obj) => nodejs.channel.send(JSON.stringify(obj)), [])

  useEffect(() => {
    nodejs.start('main.js')
    RNFS.mkdir(destDir).catch(() => {})
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw) } catch { return }
      const { type, data } = m
      switch (type) {
        case 'peer-connected': setStatus('Peer found, checking the code…'); break
        case 'peer-authenticated': setStatus('Connected ✓'); break
        case 'send-started':
          setCode(data.code); setStatus('Waiting for the recipient…'); setScreen('wait'); break
        case 'waiting-confirmation': setStatus('Waiting for the recipient to confirm…'); break
        case 'transfer-started': setStatus('Sending…'); setScreen('progress'); break
        case 'offer': setOffer(data); setScreen('confirm'); break
        case 'progress': setProgress(data); break
        case 'done':
          setReceived((data && data.files) || []); setScreen('done'); break
        case 'rejected': showError('The recipient declined the transfer.'); break
        case 'cancelled':
          if (data && data.rejected) { goHome() } else if (data && data.by === 'peer') {
            showError(role.current === 'sender' ? 'The recipient cancelled the transfer.' : 'The sender cancelled the transfer.')
          } else goHome()
          break
        case 'connect-timeout': showError('Could not find the sender in 30s. Check the code.'); break
        case 'auth-failed-receiver': showError('This code does not match. Check it with the sender.'); break
        case 'code-invalidated': showError('Too many wrong-code attempts: this code is now invalid.'); break
        case 'code-expired': showError('The code expired (15 minutes with no connection).'); break
        case 'error': showError((data && data.message) || 'An unexpected error occurred.'); break
      }
    }
    nodejs.channel.addListener('message', onMsg)
    return () => nodejs.channel.removeListener('message', onMsg)
  }, [])

  function goHome () {
    sendCmd({ cmd: 'cancel' })
    role.current = null
    setCode(''); setInputCode(''); setStatus(''); setOffer(null); setProgress(null)
    setReceived([]); setScreen('home')
  }
  function showError (msg) { setErrorMsg(msg); setScreen('error') }

  async function pickAndSend () {
    try {
      const picks = await DocumentPicker.pickMultiple({ copyTo: 'cachesDirectory' })
      const paths = []
      for (const p of picks) {
        // copyTo gives a file:// path in the cache we can read in Node.
        const local = (p.fileCopyUri || p.uri || '').replace('file://', '')
        if (local) paths.push(decodeURIComponent(local))
      }
      if (!paths.length) return
      role.current = 'sender'
      setStatus('Preparing…')
      sendCmd({ cmd: 'send', paths, options: {} })
    } catch (e) {
      if (!DocumentPicker.isCancel(e)) showError('Could not pick files.')
    }
  }

  async function connect () {
    if (!inputCode.trim()) return
    if (Platform.OS === 'android') {
      try { await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE) } catch {}
    }
    role.current = 'receiver'
    setStatus("Looking for the sender…")
    setScreen('receive')
    sendCmd({ cmd: 'receive', code: inputCode, destDir, options: {} })
  }

  /* ---------------- screens ---------------- */
  if (screen === 'home') {
    return (
      <Shell>
        <View style={styles.brand}>
          <View style={styles.logo}><Text style={styles.logoTxt}>⇄</Text></View>
          <Text style={styles.h1}>NeoDrop</Text>
          <Text style={styles.tag}>Peer-to-peer file transfer.{'\n'}No server, end-to-end encrypted.</Text>
        </View>
        <Btn primary label="Send"
          onPress={() => { role.current = 'sender'; pickAndSend() }} />
        <Btn label="Receive" onPress={() => { role.current = 'receiver'; setScreen('receive') }} />
      </Shell>
    )
  }

  if (screen === 'wait') {
    return (
      <Shell>
        <Text style={styles.h2}>Pairing code</Text>
        <Text style={styles.code}>{code}</Text>
        <View style={styles.qr}><QRCode value={code || ' '} size={180} /></View>
        <Btn label="Copy code" onPress={() => Clipboard.setString(code)} />
        <Row><Spin /><Text style={styles.muted}>{status}</Text></Row>
        <Text style={styles.hint}>Share this code. It is single-use and expires after 15 minutes.</Text>
        <Btn danger label="Cancel" onPress={goHome} />
      </Shell>
    )
  }

  if (screen === 'receive') {
    return (
      <Shell>
        <Text style={styles.h2}>Receive files</Text>
        <Text style={styles.label}>Pairing code</Text>
        <TextInput style={styles.input} value={inputCode} onChangeText={setInputCode}
          autoCapitalize="characters" placeholder="TIGER-7342" placeholderTextColor="#9aa1ac" />
        <Btn primary label="Connect" onPress={connect} />
        {!!status && <Row><Spin /><Text style={styles.muted}>{status}</Text></Row>}
        <Btn danger label="Cancel" onPress={goHome} />
      </Shell>
    )
  }

  if (screen === 'confirm' && offer) {
    const total = offer.files.reduce((a, f) => a + (f.size || 0), 0)
    return (
      <Shell>
        <Text style={styles.h2}>Transfer request</Text>
        <Text style={styles.body}>
          <Text style={{ fontWeight: '700' }}>{offer.sender}</Text>
          {` wants to send you ${offer.folder ? `a folder (${offer.files.length} files` : `${offer.files.length} file(s)`}, ${fmtBytes(total)}).`}
        </Text>
        <ScrollView style={styles.list}>
          {offer.files.slice(0, 50).map((f, i) => (
            <View key={i} style={styles.fileRow}>
              <Text style={styles.fileName} numberOfLines={1}>{f.relPath || f.name}</Text>
              <Text style={styles.muted}>{fmtBytes(f.size)}</Text>
            </View>
          ))}
        </ScrollView>
        <Text style={styles.hint}>Saved to {destDir}</Text>
        <Btn primary label="Accept" onPress={() => { sendCmd({ cmd: 'accept', destDir }); setStatus('Receiving…'); setScreen('progress') }} />
        <Btn danger label="Decline" onPress={() => { sendCmd({ cmd: 'reject' }); goHome() }} />
      </Shell>
    )
  }

  if (screen === 'progress') {
    const pct = progress && progress.totalSize > 0 ? Math.floor((progress.totalBytes / progress.totalSize) * 100) : 0
    return (
      <Shell>
        <Text style={styles.h2}>{role.current === 'sender' ? 'Sending…' : 'Receiving…'}</Text>
        <Text style={styles.code}>{pct}%</Text>
        <View style={styles.bar}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
        {progress && (
          <Text style={styles.muted}>
            {fmtBytes(progress.totalBytes)} of {fmtBytes(progress.totalSize)}
            {progress.speed ? `  ·  ${fmtBytes(progress.speed)}/s` : ''}
          </Text>
        )}
        <Btn danger label="Cancel" onPress={goHome} />
      </Shell>
    )
  }

  if (screen === 'done') {
    return (
      <Shell>
        <Text style={[styles.h1, { color: '#16a34a' }]}>✓</Text>
        <Text style={styles.h2}>Transfer complete</Text>
        <Text style={styles.muted}>
          {role.current === 'receiver' ? 'Integrity verified. Files saved to:' : 'The recipient received all files.'}
        </Text>
        {role.current === 'receiver' && <Text style={styles.hint}>{destDir}</Text>}
        <Btn primary label="New transfer" onPress={goHome} />
      </Shell>
    )
  }

  return (
    <Shell>
      <Text style={[styles.h1, { color: '#dc2626' }]}>✕</Text>
      <Text style={styles.h2}>Oops</Text>
      <Text style={styles.body}>{errorMsg}</Text>
      <Btn primary label="Back to home" onPress={goHome} />
    </Shell>
  )
}

/* ---------------- small components ---------------- */
const Shell = ({ children }) => (
  <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.wrap}>{children}</ScrollView></SafeAreaView>
)
const Btn = ({ label, onPress, primary, danger }) => (
  <TouchableOpacity onPress={onPress}
    style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger]}>
    <Text style={[styles.btnTxt, primary && { color: '#fff' }, danger && { color: '#dc2626' }]}>{label}</Text>
  </TouchableOpacity>
)
const Row = ({ children }) => <View style={styles.row}>{children}</View>
const Spin = () => <ActivityIndicator color={ACCENT} style={{ marginRight: 8 }} />

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  wrap: { padding: 24, gap: 14, flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: 16 },
  logo: { width: 64, height: 64, borderRadius: 18, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  logoTxt: { color: '#fff', fontSize: 30 },
  h1: { fontSize: 30, fontWeight: '800', textAlign: 'center', color: '#141922' },
  h2: { fontSize: 20, fontWeight: '700', textAlign: 'center', color: '#141922' },
  tag: { color: '#6b7280', textAlign: 'center', marginTop: 6 },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 2, color: ACCENT, textAlign: 'center' },
  qr: { alignItems: 'center', padding: 16, backgroundColor: '#fff', borderRadius: 12, alignSelf: 'center' },
  label: { color: '#6b7280', fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#d6dae1', borderRadius: 10, padding: 14, fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: 2, backgroundColor: '#fff', color: '#141922' },
  btn: { borderWidth: 1, borderColor: '#d6dae1', borderRadius: 10, padding: 14, alignItems: 'center', backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: ACCENT, borderColor: ACCENT },
  btnDanger: { borderColor: '#dc2626', backgroundColor: 'transparent' },
  btnTxt: { fontSize: 16, fontWeight: '600', color: '#141922' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  muted: { color: '#6b7280', textAlign: 'center' },
  hint: { color: '#6b7280', fontSize: 13, textAlign: 'center' },
  body: { color: '#141922', fontSize: 15, textAlign: 'center' },
  list: { maxHeight: 200, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e4e7ec' },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, borderBottomWidth: 1, borderBottomColor: '#eef0f2' },
  fileName: { flex: 1, marginRight: 10, color: '#141922' },
  bar: { height: 10, backgroundColor: '#e4e7ec', borderRadius: 999, overflow: 'hidden' },
  fill: { height: 10, backgroundColor: ACCENT }
})
