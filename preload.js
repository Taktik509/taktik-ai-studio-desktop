/**
 * Preload — minimal safe bridge between the app shell and the offline page.
 * The website itself runs with no Node access (sandboxed).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taktik', {
  retry: () => ipcRenderer.send('taktik:retry'),
  openToolkit: (tool) => ipcRenderer.send('taktik:open-toolkit', tool || ''),
  getVersion: () => ipcRenderer.invoke('taktik:version'),
  platform: process.platform,
  // Toolbar navigation (assets/toolbar.html)
  nav: (action) => ipcRenderer.send('taktik:nav', action),
  navStateRequest: () => ipcRenderer.send('taktik:nav-state-request'),
  onNavState: (cb) => ipcRenderer.on('taktik:nav-state', (_e, s) => cb(s)),
});
