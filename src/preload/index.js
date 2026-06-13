'use strict'

/**
 * Preload : expose au renderer une API minimale et figée via contextBridge.
 * Aucun accès Node n'est donné au renderer ; chaque méthode correspond à
 * une commande de haut niveau gérée par le process main (ipc.js).
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /* --- envoi --- */
  // Démarre une session d'envoi (fichiers et/ou dossiers) : le main étend
  // les dossiers. Retourne { code, expiresAt, files, folder } ou { error }.
  startSend: (paths) => ipcRenderer.invoke('send:start', paths),
  // Ouvre le sélecteur de fichiers natif : retourne un tableau de chemins.
  chooseFiles: () => ipcRenderer.invoke('dialog:chooseFiles'),
  // Ouvre le sélecteur de dossier : retourne un tableau (0 ou 1 chemin).
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  // Résout le chemin disque d'un File/dossier issu d'un drag & drop.
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
