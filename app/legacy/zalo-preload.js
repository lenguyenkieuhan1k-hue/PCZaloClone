'use strict'
const { ipcRenderer } = require('electron')

// Get profile name from CLI args
const profileArg = process.argv.find(function(a) { return a.startsWith('--zalomask-profile=') })
const profileName = profileArg ? profileArg.slice('--zalomask-profile='.length) : ''

// Seed localStorage synchronously before page JS runs
if (profileName) {
  try {
    const seed = ipcRenderer.sendSync('get-ls-seed', profileName)
    if (seed && typeof seed === 'object') {
      const keys = Object.keys(seed)
      if (keys.length > 0) {
        for (var i = 0; i < keys.length; i++) {
          try { window.localStorage.setItem(keys[i], seed[keys[i]]) } catch (_) {}
        }
        console.log('[ZaloMask] Seeded localStorage:', keys.length, 'keys for', profileName)
      }
    }
  } catch (e) {
    console.warn('[ZaloMask] localStorage seed failed:', e.message)
  }
}

// Listen for session capture events from MAIN world script
window.addEventListener('__zalomask__', function(event) {
  try {
    const data = JSON.parse(event.detail)
    if (data && profileName) {
      ipcRenderer.send('zalomask:capture', Object.assign({ profileName: profileName }, data))
    }
  } catch (_) {}
})