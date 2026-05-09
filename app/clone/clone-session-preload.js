'use strict'

/* ZaloMask clone-session-preload — runs in ISOLATED world of every Zalo PC
 * renderer (registered via session.setPreloads in clone-main-shim.js).
 *
 * Three jobs, in order:
 *   1. SEED — Before any Zalo bundle script runs, hydrate localStorage with
 *      the canonical identity values exported from a previous machine
 *      (sh_z_uuid, z_uuid, decryptKey, commonParams, ...) so the page sees
 *      the same device on first paint. Solves the "Zalo overwrites imei
 *      before shim's executeJavaScript catches up" race condition.
 *   2. INJECT — Read clone-runtime-collector.js from disk and append it as a
 *      <script> tag so its body runs in MAIN world and can reach Zalo's
 *      $$afmc / webpack internals.
 *   3. BRIDGE — Listen for postMessage events from the collector and forward
 *      them to the Electron main process via ipcRenderer.
 */

const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron')

const CLONE_IMEI = String(process.env.ZALOMASK_CLONE_IMEI || '').trim()
const SEED_PATH = String(process.env.ZALOMASK_CLONE_SEED_PATH || '').trim()
const CLONE_ID = String(process.env.ZALOMASK_CLONE_ID || '').trim()

const IDENTITY_KEYS = ['sh_z_uuid', 'z_uuid']

function readSeed() {
  if (!SEED_PATH || !fs.existsSync(SEED_PATH)) return null
  try {
    const text = fs.readFileSync(SEED_PATH, 'utf8')
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function buildSeedMaps(seed) {
  // Seed file now carries full localStorage/sessionStorage snapshots.
  // Restoring only a whitelist of keys can lose login state and force re-auth.
  const localMap = {}
  const sessionMap = {}

  if (seed && seed.localStorage && typeof seed.localStorage === 'object') {
    for (const [key, value] of Object.entries(seed.localStorage)) {
      if (typeof key === 'string' && typeof value === 'string') localMap[key] = value
    }
  }
  if (seed && seed.sessionStorage && typeof seed.sessionStorage === 'object') {
    for (const [key, value] of Object.entries(seed.sessionStorage)) {
      if (typeof key === 'string' && typeof value === 'string') sessionMap[key] = value
    }
  }

  if (CLONE_IMEI) {
    for (const key of IDENTITY_KEYS) {
      localMap[key] = CLONE_IMEI
      sessionMap[key] = CLONE_IMEI
    }
  }
  // Identity (zUuid) from seed takes priority over older labels.
  if (seed && seed.identity && seed.identity.zUuid) {
    for (const key of IDENTITY_KEYS) {
      localMap[key] = seed.identity.zUuid
      sessionMap[key] = seed.identity.zUuid
    }
  }

  return { localMap, sessionMap }
}

function pinStorageMap(storage, map) {
  if (!storage || !map || !Object.keys(map).length) return
  // Wrap setItem/removeItem/clear once so Zalo cannot overwrite seeded
  // identity values once the page is live.
  try {
    if (!storage.__zalomaskPinned) {
      const origSet = typeof storage.setItem === 'function' ? storage.setItem.bind(storage) : null
      const origRemove = typeof storage.removeItem === 'function' ? storage.removeItem.bind(storage) : null
      const origClear = typeof storage.clear === 'function' ? storage.clear.bind(storage) : null
      const pinned = new Set(IDENTITY_KEYS)

      if (origSet) {
        storage.setItem = function (key, value) {
          if (pinned.has(String(key || '')) && map[key]) return origSet(key, map[key])
          return origSet(key, value)
        }
      }
      if (origRemove) {
        storage.removeItem = function (key) {
          if (pinned.has(String(key || '')) && map[key]) return origSet ? origSet(key, map[key]) : undefined
          return origRemove(key)
        }
      }
      if (origClear) {
        storage.clear = function () {
          const ret = origClear()
          if (origSet) {
            for (const k of pinned) if (map[k]) origSet(k, map[k])
          }
          return ret
        }
      }
      try {
        Object.defineProperty(storage, '__zalomaskPinned', {
          configurable: false, enumerable: false, writable: false, value: true
        })
      } catch (_) {}
    }

    for (const [key, value] of Object.entries(map)) {
      if (typeof value !== 'string') continue
      try { storage.setItem(key, value) } catch (_) {}
    }
  } catch (_) {}
}

function applySeedToBothStorages() {
  if (typeof window === 'undefined') return null
  const seed = readSeed()
  const { localMap, sessionMap } = buildSeedMaps(seed)
  if (!Object.keys(localMap).length && !Object.keys(sessionMap).length) return seed
  try { pinStorageMap(window.localStorage, localMap) } catch (_) {}
  try { pinStorageMap(window.sessionStorage, sessionMap) } catch (_) {}
  return seed
}

/* ---------- Inject runtime collector into MAIN world ---------- */

function loadCollectorSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'clone-runtime-collector.js'), 'utf8')
  } catch (_) {
    return ''
  }
}

let collectorInjected = false
function injectCollector() {
  if (collectorInjected) return
  if (typeof document === 'undefined') return
  const target = document.head || document.documentElement || document.body
  if (!target) return
  const source = loadCollectorSource()
  if (!source) return
  try {
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.textContent = source
    target.appendChild(script)
    // Self-cleanup keeps the page DOM tidy. Source has already executed.
    try { script.remove() } catch (_) {}
    collectorInjected = true
  } catch (_) {}
}

/* ---------- Bridge: forward MAIN-world snapshots to main process ---------- */

function onCollectorMessage(event) {
  if (!event || !event.data) return
  const data = event.data
  if (!data || data.source !== '__zalomask_collector__') return
  try {
    ipcRenderer.send('zalomask:session-snapshot', {
      cloneId: CLONE_ID || '',
      type: data.type || 'snapshot',
      capturedAt: data.capturedAt || new Date().toISOString(),
      payload: data.payload || null
    })
  } catch (_) {}
}

function onMainProcessPullRequest(_event, payload) {
  // Main process asks the renderer for a fresh snapshot (e.g. at export time).
  try {
    window.postMessage({
      source: '__zalomask_pull__',
      reason: (payload && payload.reason) || 'pull'
    }, '*')
  } catch (_) {}
}

function bootBridge() {
  try { window.addEventListener('message', onCollectorMessage) } catch (_) {}
  try { ipcRenderer.on('zalomask:session-snapshot-pull', onMainProcessPullRequest) } catch (_) {}
}

/* ---------- Boot order matters: seed first, then inject + bridge ---------- */

applySeedToBothStorages()
injectCollector()
bootBridge()

window.addEventListener('DOMContentLoaded', function () {
  // Re-pin in case the bundle cleared storage during early init.
  applySeedToBothStorages()
  injectCollector()
})

window.addEventListener('focus', function () {
  applySeedToBothStorages()
})
