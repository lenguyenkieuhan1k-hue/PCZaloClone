/* ZaloMask Runtime Collector — runs in MAIN world of Zalo PC renderer.
 *
 * Loaded as a string by clone-session-preload.js and injected into the page
 * via a <script> tag so this code shares context with Zalo's bundle. From
 * there it can reach window.$$afmc, webpack module cache, and any other
 * Zalo-internal state — same trick the Chrome-extension flavor of the
 * project uses on chat.zalo.me.
 *
 * Output channel: window.postMessage({ source: '__zalomask_collector__', ... })
 * The ISOLATED-world bridge in clone-session-preload.js listens for those
 * messages and forwards them to the Electron main process via ipcRenderer.
 *
 * IMPORTANT: keep this file self-contained. It is concatenated into a string
 * and run inside the Zalo page; do not require() anything here. */

(function zalomaskCollector() {
  'use strict'
  if (window.__zalomaskCollectorInstalled) return
  window.__zalomaskCollectorInstalled = true

  var POLL_INTERVAL_MS = 1000
  var MAX_POLL_ATTEMPTS = 180        // ~3 minutes total
  var INITIAL_DELAY_MS = 1500
  var EXTRACTION_RETRIES = 6
  var EXTRACTION_RETRY_DELAY_MS = 1500
  var DEBOUNCE_DELAY_MS = 1200

  var lastSnapshotJson = ''
  var debounceTimer = null

  function post(type, payload) {
    try {
      window.postMessage({
        source: '__zalomask_collector__',
        type: type,
        capturedAt: new Date().toISOString(),
        payload: payload || null
      }, '*')
    } catch (_) {}
  }

  function safe(fn, fallback) {
    try { return fn() } catch (_) { return fallback }
  }

  /* ---------- localStorage / sessionStorage canonical keys ---------- */

  // Keys we know matter for re-hydrating Zalo on another machine. These come
  // from the original web-extension reverse engineering work and the existing
  // ZaloMask shim — anything Zalo writes here we want to capture verbatim.
  var IDENTITY_KEYS = ['sh_z_uuid', 'z_uuid']
  var SESSION_KEY_HINTS = [
    'decryptKey', 'sh_decryptKey',
    'commonParams', 'sh_commonParams',
    'labelVersion', 'sh_labelVersion',
    'app.config', 'shareInfo', 'imei',
    'logged_user_id', 'oid', 'lang'
  ]

  function readStorageSnapshot() {
    var snapshot = { localStorage: {}, sessionStorage: {} }
    function dump(storage, target) {
      if (!storage) return
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i)
        if (!key) continue
        try { target[key] = storage.getItem(key) } catch (_) {}
      }
    }
    safe(function () { dump(window.localStorage, snapshot.localStorage) })
    safe(function () { dump(window.sessionStorage, snapshot.sessionStorage) })
    return snapshot
  }

  function pickSessionHints(storageSnapshot) {
    var out = {}
    var sources = [storageSnapshot.localStorage, storageSnapshot.sessionStorage]
    SESSION_KEY_HINTS.forEach(function (key) {
      for (var i = 0; i < sources.length; i++) {
        if (sources[i] && Object.prototype.hasOwnProperty.call(sources[i], key)) {
          out[key] = sources[i][key]
          break
        }
      }
    })
    return out
  }

  function pickIdentity(storageSnapshot) {
    var localS = storageSnapshot.localStorage || {}
    var sessionS = storageSnapshot.sessionStorage || {}
    var zUuid = localS.sh_z_uuid || localS.z_uuid || sessionS.sh_z_uuid || sessionS.z_uuid || ''
    return { zUuid: String(zUuid || '').trim() }
  }

  /* ---------- Optional Zalo internal hooks ---------- */
  // These match the names from the Zalo Web extension. They may not exist on
  // Zalo PC for every version, so every probe is wrapped in safe(). Even if
  // none of these resolve, the localStorage snapshot above is enough to keep
  // the device portable on a destination machine.

  function probeZStorage() {
    var afmc = window.$$afmc
    if (!afmc || !afmc.zStorage) return null
    return afmc.zStorage
  }

  function probeWebpack() {
    var candidates = ['webpackJsonp', 'webpackChunk', '__webpack_require__']
    for (var i = 0; i < candidates.length; i++) {
      var key = candidates[i]
      if (typeof window[key] === 'function') return window[key]
    }
    return null
  }

  function probeZaloClientId() {
    return safe(function () {
      var afmc = window.$$afmc
      if (!afmc) return ''
      if (typeof afmc.getZaloClientID === 'function') return afmc.getZaloClientID()
      if (afmc.appContext && typeof afmc.appContext.getZaloClientID === 'function') {
        return afmc.appContext.getZaloClientID()
      }
      return ''
    }, '') || ''
  }

  async function probeMe() {
    var zStorage = probeZStorage()
    if (!zStorage) return null
    try {
      if (typeof zStorage.getMe === 'function') {
        var result = await zStorage.getMe()
        return result || null
      }
    } catch (_) {}
    return null
  }

  /* ---------- Snapshot assembly ---------- */

  async function buildSnapshot(reason) {
    var storage = readStorageSnapshot()
    var identity = pickIdentity(storage)
    var hints = pickSessionHints(storage)
    var clientId = probeZaloClientId()
    var me = await probeMe()

    return {
      reason: reason || 'periodic',
      identity: {
        zUuid: identity.zUuid || '',
        clientId: clientId || ''
      },
      session: {
        decryptKey: hints.decryptKey || hints.sh_decryptKey || '',
        commonParams: hints.commonParams || hints.sh_commonParams || '',
        labelVersion: hints.labelVersion || hints.sh_labelVersion || '',
        userId: hints.oid || hints.logged_user_id || '',
        rawHints: hints
      },
      me: me,
      storage: storage,
      page: {
        url: safe(function () { return location.href }, ''),
        userAgent: safe(function () { return navigator.userAgent }, '')
      }
    }
  }

  function snapshotFingerprint(snapshot) {
    // Hash-light: cheap stable signature so we can skip duplicate posts.
    try {
      return JSON.stringify({
        z: snapshot.identity.zUuid,
        c: snapshot.identity.clientId,
        d: snapshot.session.decryptKey,
        p: snapshot.session.commonParams,
        u: snapshot.session.userId,
        m: snapshot.me ? (snapshot.me.userId || snapshot.me.uid || '') : ''
      })
    } catch (_) { return '' }
  }

  async function emitSnapshot(reason) {
    var snapshot = await buildSnapshot(reason)
    var fingerprint = snapshotFingerprint(snapshot)
    if (fingerprint && fingerprint === lastSnapshotJson) return false
    lastSnapshotJson = fingerprint
    post('snapshot', snapshot)
    return true
  }

  function debouncedEmit(reason) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(function () {
      debounceTimer = null
      emitSnapshot(reason).catch(function () {})
    }, DEBOUNCE_DELAY_MS)
  }

  /* ---------- Storage write hooks: re-emit on change ---------- */

  function instrumentStorage(storage, label) {
    if (!storage || storage.__zalomaskCollectorPatched) return
    try {
      var origSet = storage.setItem.bind(storage)
      var origRemove = storage.removeItem.bind(storage)
      var origClear = storage.clear.bind(storage)
      storage.setItem = function (key, value) {
        var ret = origSet(key, value)
        try { debouncedEmit('storage:' + label + ':set:' + key) } catch (_) {}
        return ret
      }
      storage.removeItem = function (key) {
        var ret = origRemove(key)
        try { debouncedEmit('storage:' + label + ':del:' + key) } catch (_) {}
        return ret
      }
      storage.clear = function () {
        var ret = origClear()
        try { debouncedEmit('storage:' + label + ':clear') } catch (_) {}
        return ret
      }
      Object.defineProperty(storage, '__zalomaskCollectorPatched', {
        value: true, writable: false, enumerable: false, configurable: false
      })
    } catch (_) {}
  }

  /* ---------- Boot ---------- */

  async function bootCollector() {
    instrumentStorage(window.localStorage, 'L')
    instrumentStorage(window.sessionStorage, 'S')

    // Initial emit after a short delay so first paint of Zalo finishes writing
    // its initial localStorage state.
    setTimeout(function () { debouncedEmit('initial') }, INITIAL_DELAY_MS)

    // Aggressive retry pass to catch the value Zalo sets *after* its first
    // server handshake (decryptKey / commonParams typically appear ~2-3s after
    // login). Mirrors the EXTRACTION_RETRIES loop from the web extension.
    for (var round = 1; round <= EXTRACTION_RETRIES; round++) {
      await new Promise(function (resolve) {
        setTimeout(function () {
          emitSnapshot('retry:' + round).catch(function () {})
          resolve()
        }, INITIAL_DELAY_MS + round * EXTRACTION_RETRY_DELAY_MS)
      })
    }

    // Long-tail: once a minute, snapshot again so any later mutation
    // (e.g. user logs in/out, rotates UUID) eventually reaches main.
    setInterval(function () { debouncedEmit('heartbeat') }, 60 * 1000)
  }

  // Wait for $$afmc / DOM if very early; otherwise kick off immediately.
  function waitForReady(attempt) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bootCollector().catch(function () {}) }, { once: true })
      return
    }
    bootCollector().catch(function () {})
  }

  waitForReady(0)

  // Listen for explicit pull requests from the bridge — the main process
  // asks for an immediate snapshot at export time.
  window.addEventListener('message', function (event) {
    if (!event || !event.data) return
    var data = event.data
    if (data.source !== '__zalomask_pull__') return
    emitSnapshot(data.reason || 'pull').catch(function () {})
  })

})();
