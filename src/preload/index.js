'use strict'

/**
 * Preload : expose au renderer une API minimale et figée via contextBridge.
 * Aucun accès Node n'est donné au renderer ; chaque méthode correspond à
 * une commande de haut niveau gérée par le process main (ipc.js).
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /* --- envoi --- */
  // Démarre une session d'envoi : retourne { code, expiresAt } ou { error }.
  startSend: (filePaths) => ipcRenderer.invoke('send:start', filePaths),
  // Ouvre le sélecteur de fichiers natif : retourne un tableau de chemins.
  chooseFiles: () => ipcRenderer.invoke('dialog:chooseFiles'),
  // Résout le chemin disque d'un File issu d'un drag & drop (sandbox oblige).
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },

  /* --- réception --- */
  // Rejoint le pair avec le code saisi : retourne { ok } ou { error }.
  startReceive: (code) => ipcRenderer.invoke('receive:start', code),
  // Confirmation explicite : seul déclencheur d'écriture disque.
  accept: (destDir) => ipcRenderer.invoke('receive:accept', destDir),
  reject: () => ipcRenderer.invoke('receive:reject'),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  getDefaultDir: () => ipcRenderer.invoke('config:getDefaultDir'),

  /* --- commun --- */
  cancel: () => ipcRenderer.invoke('session:cancel'),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),

  // Abonnement aux événements de session (progression, erreurs, etc.).
  // Retourne une fonction de désabonnement.
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('session-event', listener)
    return () => ipcRenderer.removeListener('session-event', listener)
  }
})
