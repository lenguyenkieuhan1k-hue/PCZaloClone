const { ipcRenderer } = require('electron')

function getArg(prefix) {
  const arg = process.argv.find((entry) => String(entry).startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}

const zUuid = getArg('--zalomask-zuuid=')
const profileName = getArg('--zalomask-profile=')

// Full localStorage seed passed as base64-encoded JSON via additionalArguments
const localStorageSeedB64 = getArg('--zalomask-ls-seed=')
function parseLocalStorageSeed() {
  if (!localStorageSeedB64) return null
  try {
    const json = Buffer.from(localStorageSeedB64, 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) { return null }
}

const IDENTITY_KEYS = ['sh_z_uuid', 'z_uuid']

function seedWebSession() {
  try {
    if (location.hostname !== 'chat.zalo.me') return
    const seed = parseLocalStorageSeed()
    if (seed) {
      // Restore full localStorage snapshot so Zalo sees the original session state
      for (const [key, value] of Object.entries(seed)) {
        if (typeof key === 'string' && typeof value === 'string') {
          try { localStorage.setItem(key, value) } catch (_) {}
        }
      }
    }
    // Always override identity keys with the canonical zUuid
    if (zUuid) {
      for (const key of IDENTITY_KEYS) {
        try { localStorage.setItem(key, zUuid) } catch (_) {}
      }
    }
  } catch (_) {}
}

// Capture current cookies + localStorage and send to main process for persistence
async function captureAndSaveSession(reason) {
  try {
    if (!profileName) return
    if (location.hostname !== 'chat.zalo.me') return
    const localStorageSnapshot = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k) localStorageSnapshot[k] = localStorage.getItem(k)
    }
    ipcRenderer.send('zalomask:web-session-snapshot', {
      profileName,
      reason,
      localStorage: localStorageSnapshot,
    })
  } catch (_) {}
}

seedWebSession()
window.addEventListener('DOMContentLoaded', () => {
  seedWebSession()
})
window.addEventListener('load', () => {
  // Capture session ~5s after page finishes loading (give Zalo time to write tokens)
  setTimeout(() => captureAndSaveSession('page-load'), 5000)
  setTimeout(() => captureAndSaveSession('page-load-late'), 30000)
})
