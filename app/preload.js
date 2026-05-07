'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Profile CRUD
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  getProfileInfo: (profileName) => ipcRenderer.invoke('get-profile-info', { profileName }),
  addProfile: (displayName, proxy) => ipcRenderer.invoke('add-profile', { displayName, proxy }),
  openProfile: (profileName) => ipcRenderer.invoke('open-profile', { profileName }),
  launchAll: () => ipcRenderer.invoke('launch-all'),
  deleteProfile: (profileName) => ipcRenderer.invoke('delete-profile', { profileName }),
  updateProxy: (profileName, proxy) => ipcRenderer.invoke('update-proxy', { profileName, proxy }),
  checkProxy: (proxy) => ipcRenderer.invoke('check-proxy', { proxy }),
  exportProfile: (profileName) => ipcRenderer.invoke('export-profile', { profileName }),
  exportProfiles: (profileNames) => ipcRenderer.invoke('export-profiles', { profileNames }),
  importProfile: () => ipcRenderer.invoke('import-profile'),
  openProfilesFolder: () => ipcRenderer.invoke('open-profiles-folder'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  getSystemHealth: () => ipcRenderer.invoke('get-system-health'),

  // License
  getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
  activateLicense: (key) => ipcRenderer.invoke('activate-license', { key }),
  deactivateLicense: () => ipcRenderer.invoke('deactivate-license'),
  heartbeatLicense: () => ipcRenderer.invoke('license-heartbeat'),

  // Auto-update
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateStatus: () => ipcRenderer.invoke('update-status'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', (_, info) => cb(info))
  },
  onUpdateProgress: (cb) => {
    ipcRenderer.on('update-download-progress', (_, info) => cb(info))
  },

  // Window controls
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),

  // Events
  onProfileUpdated: (cb) => {
    ipcRenderer.on('profile-updated', (_, profileName) => cb(profileName))
  },
  onLicenseUpdated: (cb) => {
    ipcRenderer.on('license-updated', (_, state) => cb(state))
  },
  onLicenseKicked: (cb) => {
    ipcRenderer.on('license-kicked', (_, info) => cb(info))
  },
})
