'use strict'

// Preload: exposes a minimal, frozen API to the renderer via contextBridge.
// The renderer gets no Node access; each method maps to a main-process command.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Send files and/or folders. opts = { strength, passphrase, compression, rateLimit }.
  startSend: (paths, opts) => ipcRenderer.invoke('send:start', paths, opts),
  chooseFiles: () => ipcRenderer.invoke('dialog:chooseFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },

  // Join a peer with the typed code. opts = { passphrase }.
  startReceive: (code, opts) => ipcRenderer.invoke('receive:start', code, opts),
  accept: (destDir) => ipcRenderer.invoke('receive:accept', destDir),
  reject: () => ipcRenderer.invoke('receive:reject'),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  getDefaultDir: () => ipcRenderer.invoke('config:getDefaultDir'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  cancel: () => ipcRenderer.invoke('session:cancel'),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),

  // Subscribe to session events. Returns an unsubscribe function.
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('session-event', listener)
    return () => ipcRenderer.removeListener('session-event', listener)
  }
})
