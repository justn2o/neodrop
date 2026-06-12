'use strict'

/**
 * Point d'entrée Electron : cycle de vie de l'application et fenêtre unique.
 * Sécurité : contextIsolation, sandbox, pas de nodeIntegration — le
 * renderer ne parle au main que via l'API minimale du preload.
 */

const path = require('path')
const { app, BrowserWindow } = require('electron')
const { registerIpcHandlers, shutdown } = require('./ipc')

let mainWindow = null

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    title: 'NeoDrop',
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

// Une seule instance UI par profil utilisateur n'est PAS imposée : pouvoir
// lancer deux instances sur la même machine sert justement aux tests locaux.

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Fermeture pendant un transfert : on coupe la session proprement et on
// supprime les fichiers temporaires .part.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  shutdown().finally(() => app.quit())
})
