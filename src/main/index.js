'use strict'

// Electron entry point: app lifecycle and the single window.
// Hardened renderer: contextIsolation, sandbox, no nodeIntegration - the
// renderer talks to main only through the minimal preload API.

const path = require('path')
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron')
const { registerIpcHandlers, shutdown } = require('./ipc')

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png')
const TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'tray.png')

let mainWindow = null
let tray = null

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    title: 'NeoDrop',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

function showWindow () {
  if (!mainWindow) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
}

// Tray icon: keep a pending code in the background and return with one click.
function createTray () {
  try {
    const img = nativeImage.createFromPath(TRAY_ICON_PATH)
    if (img.isEmpty()) return
    tray = new Tray(img)
    tray.setToolTip('NeoDrop')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open NeoDrop', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]))
    tray.on('click', showWindow)
  } catch { tray = null }
}

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow)
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  if (tray) { try { tray.destroy() } catch {} tray = null }
  shutdown().finally(() => app.quit())
})
