'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Profile CRUD
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  getProfileInfo: (profileName) => ipcRenderer.invoke('get-profile-info', { profileName }),
  addProfile: (displayName, proxy, launchMode) => ipcRenderer.invoke('add-profile', { displayName, proxy, launchMode }),
  cloneRuntimeStatus: () => ipcRenderer.invoke('clone-runtime-status'),
  openProfile: (profileName) => ipcRenderer.invoke('open-profile', { profileName }),
  launchAll: () => ipcRenderer.invoke('launch-all'),
  deleteProfile: (profileName) => ipcRenderer.invoke('delete-profile', { profileName }),
  renameProfile: (profileName, displayName) => ipcRenderer.invoke('rename-profile', { profileName, displayName }),
  updateProxy: (profileName, proxy) => ipcRenderer.invoke('update-proxy', { profileName, proxy }),
  checkProxy: (proxy) => ipcRenderer.invoke('check-proxy', { proxy }),
  exportProfile: (profileName, opts = {}) =>
    ipcRenderer.invoke('export-profile', { profileName, deleteAfterExport: !!opts.deleteAfterExport }),
  exportProfiles: (profileNames, opts = {}) =>
    ipcRenderer.invoke('export-profiles', { profileNames, deleteAfterExport: !!opts.deleteAfterExport }),
  importProfile: () => ipcRenderer.invoke('import-profile'),
  createProfileShortcut: (profileName) => ipcRenderer.invoke('create-profile-shortcut', { profileName }),
  openProfilesFolder: () => ipcRenderer.invoke('open-profiles-folder'),

  // Per-profile privacy
  getProfilePrivacy: (profileName) => ipcRenderer.invoke('get-profile-privacy', { profileName }),
  setProfilePrivacy: (profileName, key, value) => ipcRenderer.invoke('set-profile-privacy', { profileName, key, value }),

  // Settings (global defaults)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  getSystemHealth: () => ipcRenderer.invoke('get-system-health'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  logToMain: (level, message, detail) =>
    ipcRenderer.invoke('client-log', { level, message, detail }),
  nudgeComposite: () => ipcRenderer.invoke('nudge-composite'),

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

  // Cloud sync
  cloudSyncUpload: () => ipcRenderer.invoke('cloud-sync-upload'),
  cloudSyncDownload: () => ipcRenderer.invoke('cloud-sync-download'),
  cloudSyncStatus: () => ipcRenderer.invoke('cloud-sync-status'),

  // Events
  onProfileUpdated: (cb) => {
    ipcRenderer.on('profile-updated', (_, profileName) => cb(profileName))
  },
  onProfilesReloaded: (cb) => {
    ipcRenderer.on('profiles-reloaded', (_) => cb())
  },
  onLicenseUpdated: (cb) => {
    ipcRenderer.on('license-updated', (_, state) => cb(state))
  },
  onLicenseKicked: (cb) => {
    ipcRenderer.on('license-kicked', (_, info) => cb(info))
  },
})
