'use strict'

/* ZaloMask clone-main-shim — runs inside Zalo.exe's main process.
 *
 * Three jobs:
 *   1. Reroute APPDATA to a per-clone wrapper before Zalo's bootstrap reads
 *      anything (so ElectronSessionData / Local State land in the right dir).
 *   2. Hydrate cookies into Electron's session at boot from
 *      zalomask-account.json (legacy carry-over for now; full snapshots live
 *      in profiles/<name>/session-snapshot.json on the ZaloMask side).
 *   3. Bridge the live runtime collector running in the Zalo renderer:
 *      capture every postMessage forwarded by clone-session-preload.js, write
 *      a canonical session-snapshot.json that ZaloMask reads at export time.
 *
 * The collector itself is documented in clone-runtime-collector.js. The
 * preload/bridge half lives in clone-session-preload.js. */

const fs = require('fs')
const path = require('path')
const { app, session, BrowserWindow, ipcMain } = require('electron')

const CLONE_ARG_PREFIX = '--appdata-id='
const CLONE_ENV_DIR = '__zalomask_clone_env__'
const CLONE_ACCOUNT_FILE = 'zalomask-account.json'
const CLONE_SEED_FILE = 'zalomask-seed.json'
const COOKIE_SAVE_DEBOUNCE_MS = 800
const SNAPSHOT_DEBOUNCE_MS = 600
const ZALO_COOKIE_HOSTS = ['.zalo.me', '.chat.zalo.me', '.zaloapp.com', '.zclient.zalo']
const CLONE_SESSION_PRELOAD_FILE = 'clone-session-preload.js'

let cloneDataRoot = ''
let pendingCloneImei = ''
let cookieSaveTimer = null
let snapshotSaveTimer = null
let lastSnapshotPayload = null

function getCloneId() {
  const arg = process.argv.find((entry) => String(entry || '').startsWith(CLONE_ARG_PREFIX))
  if (!arg) return ''
  return String(arg.slice(CLONE_ARG_PREFIX.length)).trim()
}

function ensureCloneJunction(linkPath, targetPath) {
  try {
    if (fs.existsSync(linkPath)) return
    fs.symlinkSync(targetPath, linkPath, 'junction')
  } catch (error) {
    try { fs.mkdirSync(linkPath, { recursive: true }) } catch {}
    try { fs.writeFileSync(path.join(linkPath, '.zalomask-link-error'), String(error && error.message ? error.message : error), 'utf8') } catch {}
  }
}

function applyCloneAppData() {
  const cloneId = getCloneId()
  if (!cloneId) return

  const baseAppData = process.env.APPDATA || app.getPath('appData')
  const wrapperRoot = path.join(baseAppData, CLONE_ENV_DIR, cloneId)
  cloneDataRoot = path.join(baseAppData, `ZaloData_${cloneId}`)

  fs.mkdirSync(cloneDataRoot, { recursive: true })
  fs.mkdirSync(wrapperRoot, { recursive: true })
  ensureCloneJunction(path.join(wrapperRoot, 'ZaloData'), cloneDataRoot)

  process.env.APPDATA = wrapperRoot
  process.env.ZALOMASK_CLONE_ID = cloneId
  process.env.ZALOMASK_CLONE_DATA_ROOT = cloneDataRoot
  // Tell the renderer-side preload where to find the seed JSON. ZaloMask
  // writes this file at import time and at every successful collector emit.
  process.env.ZALOMASK_CLONE_SEED_PATH = path.join(cloneDataRoot, CLONE_SEED_FILE)

  try { app.setPath('appData', wrapperRoot) } catch {}
  try { app.setPath('userData', path.join(wrapperRoot, 'ElectronUserData')) } catch {}
  try { app.setPath('sessionData', path.join(wrapperRoot, 'ElectronSessionData')) } catch {}
}

function getCloneAccountPath() {
  if (!cloneDataRoot) return ''
  return path.join(cloneDataRoot, CLONE_ACCOUNT_FILE)
}

function readCloneAccount() {
  try {
    const accountPath = getCloneAccountPath()
    if (!accountPath || !fs.existsSync(accountPath)) return null
    return JSON.parse(fs.readFileSync(accountPath, 'utf8'))
  } catch {
    return null
  }
}

function writeCloneAccount(account) {
  try {
    const accountPath = getCloneAccountPath()
    if (!accountPath) return false
    fs.mkdirSync(path.dirname(accountPath), { recursive: true })
    fs.writeFileSync(accountPath, JSON.stringify(account, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function normalizeCookieList(cookieInput) {
  if (!Array.isArray(cookieInput)) return []
  return cookieInput
    .filter((cookie) => cookie && cookie.name && typeof cookie.value === 'string')
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.zalo.me',
      path: cookie.path || '/',
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      session: cookie.session,
    }))
}

function buildCookieUrl(cookie) {
  const host = String(cookie.domain || '.zalo.me').replace(/^\./, '')
  return (cookie.secure === false ? 'http://' : 'https://') + host + (cookie.path || '/')
}

function getCookieKey(cookie) {
  return [
    String(cookie && cookie.name || '').trim(),
    String(cookie && cookie.domain || '.zalo.me').trim().toLowerCase(),
    String(cookie && cookie.path || '/').trim(),
  ].join('|')
}

function mergeCookieLists(...sources) {
  const merged = []
  const indexByKey = new Map()
  for (const source of sources) {
    for (const cookie of normalizeCookieList(source)) {
      const key = getCookieKey(cookie)
      if (!key) continue
      if (indexByKey.has(key)) {
        merged[indexByKey.get(key)] = cookie
        continue
      }
      indexByKey.set(key, merged.length)
      merged.push(cookie)
    }
  }
  return merged
}

function isZaloCookie(cookie) {
  const domain = String(cookie && cookie.domain || '').toLowerCase().replace(/^\./, '')
  return ZALO_COOKIE_HOSTS.some((suffix) => {
    const normalizedSuffix = suffix.replace(/^\./, '')
    return domain === normalizedSuffix || domain.endsWith(`.${normalizedSuffix}`)
  })
}

async function clearZaloCookies(targetSession) {
  const existing = await targetSession.cookies.get({})
  for (const cookie of existing) {
    if (!isZaloCookie(cookie) || !cookie.name) continue
    try {
      await targetSession.cookies.remove(buildCookieUrl(cookie), cookie.name)
    } catch {}
  }
}

async function applyCookiesToSession(targetSession, cookies) {
  const normalized = normalizeCookieList(cookies)
  if (!normalized.length) return
  await clearZaloCookies(targetSession)
  for (const cookie of normalized) {
    const details = {
      url: buildCookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: Boolean(cookie.httpOnly),
    }
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite
    if (!cookie.session && typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
      details.expirationDate = cookie.expirationDate
    }
    try {
      await targetSession.cookies.set(details)
    } catch {}
  }
  try {
    await targetSession.cookies.flushStore()
  } catch {}
  try {
    if (typeof targetSession.flushStorageData === 'function') await targetSession.flushStorageData()
  } catch {}
}

function getTrackedSessions() {
  const tracked = []
  if (session.defaultSession) tracked.push(session.defaultSession)
  try { tracked.push(session.fromPartition('persist:zalo')) } catch {}
  return tracked.filter(Boolean)
}

function updateProcessCloneImei(imei) {
  pendingCloneImei = String(imei || '').trim()
  if (pendingCloneImei) process.env.ZALOMASK_CLONE_IMEI = pendingCloneImei
  else delete process.env.ZALOMASK_CLONE_IMEI
}

function ensureCloneSessionPreload(targetSession) {
  if (!targetSession) return
  try {
    const preloadPath = path.join(__dirname, CLONE_SESSION_PRELOAD_FILE)
    if (!fs.existsSync(preloadPath)) return
    const current = typeof targetSession.getPreloads === 'function' ? targetSession.getPreloads() : []
    if (current.includes(preloadPath)) return
    if (typeof targetSession.setPreloads === 'function') {
      targetSession.setPreloads([...current, preloadPath])
    }
  } catch {}
}

async function saveLatestCloneCookies() {
  const account = readCloneAccount()
  if (!account) return

  let latestCookies = []
  const existingCookies = normalizeCookieList(account.cookies)
  const currentImei = String(account.imei || account.sessionIdentity?.zUuid || pendingCloneImei || '').trim()
  let latestImei = currentImei
  const trackedSessions = getTrackedSessions()
  const primarySession = trackedSessions[trackedSessions.length - 1] || trackedSessions[0]
  if (!primarySession) return

  try {
    latestCookies = (await primarySession.cookies.get({}))
      .filter(isZaloCookie)
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.zalo.me',
        path: cookie.path || '/',
        httpOnly: Boolean(cookie.httpOnly),
        secure: cookie.secure !== false,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        session: cookie.session,
      }))
  } catch {
    latestCookies = []
  }

  if (latestCookies.length) account.cookies = mergeCookieLists(existingCookies, latestCookies)
  if (currentImei || latestImei) {
    latestImei = currentImei || latestImei
    account.imei = latestImei
    account.sessionIdentity = { zUuid: latestImei }
    updateProcessCloneImei(latestImei)
  }
  account.updatedAt = new Date().toISOString()
  writeCloneAccount(account)
}

function scheduleCookieSave() {
  if (cookieSaveTimer) clearTimeout(cookieSaveTimer)
  cookieSaveTimer = setTimeout(() => {
    cookieSaveTimer = null
    saveLatestCloneCookies().catch(() => {})
  }, COOKIE_SAVE_DEBOUNCE_MS)
}

async function hydrateCloneAccountIfNeeded() {
  const account = readCloneAccount()
  if (!account) return

  updateProcessCloneImei(account.imei || account.sessionIdentity?.zUuid || '')

  const trackedSessions = getTrackedSessions()
  for (const targetSession of trackedSessions) ensureCloneSessionPreload(targetSession)

  if (!account.needSyncCookies) return
  const cookies = normalizeCookieList(account.cookies)
  if (!cookies.length) return

  for (const targetSession of trackedSessions) {
    await applyCookiesToSession(targetSession, cookies)
  }

  account.needSyncCookies = false
  account.lastHydratedAt = new Date().toISOString()
  writeCloneAccount(account)
}

/* ---------- Live runtime snapshot bridge ----------
 *
 * The renderer-side preload (clone-session-preload.js) injects
 * clone-runtime-collector.js into the page (MAIN world) and forwards every
 * snapshot here over IPC. We persist them in two places:
 *
 *   • <cloneDataRoot>/session-snapshot-live.json  — local journal owned by
 *     this Zalo.exe instance. Useful for diagnostics / crash recovery.
 *   • <ZALOMASK_SNAPSHOT_PATH>                    — the canonical file the
 *     ZaloMask main process reads at export / list time. Path is supplied
 *     by ZaloMask when the clone is launched.
 *
 * Cookies & cookieKeyB64 are NOT collected here — those still live behind
 * Electron's session API and DPAPI respectively, so ZaloMask reads them
 * directly when the user clicks Sao lưu. */

function getLiveSnapshotPath() {
  if (!cloneDataRoot) return ''
  return path.join(cloneDataRoot, 'session-snapshot-live.json')
}

function getCanonicalSnapshotPath() {
  return String(process.env.ZALOMASK_SNAPSHOT_PATH || '').trim()
}

function writeJsonAtomicSafe(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, filePath)
    return true
  } catch (error) {
    try {
      fs.writeFileSync(filePath + '.error', String(error && error.message ? error.message : error), 'utf8')
    } catch {}
    return false
  }
}

function buildCanonicalRecord(payload, profileName, displayName, cloneId) {
  const incoming = payload && payload.payload ? payload.payload : null
  if (!incoming) return null
  const capturedAt = (payload && payload.capturedAt) || new Date().toISOString()
  return {
    profileName: profileName || '',
    displayName: displayName || '',
    cloneId: cloneId || '',
    capturedAt,
    identity: incoming.identity || {},
    session: incoming.session || {},
    me: incoming.me || null,
    storage: incoming.storage || { localStorage: {}, sessionStorage: {} },
    page: incoming.page || {}
  }
}

function persistSnapshot(payload) {
  if (!payload || !payload.payload) return
  lastSnapshotPayload = payload

  // Local journal (always written, even without ZaloMask running).
  const liveTarget = getLiveSnapshotPath()
  if (liveTarget) writeJsonAtomicSafe(liveTarget, payload)

  // Canonical record for ZaloMask main process.
  const canonicalTarget = getCanonicalSnapshotPath()
  if (canonicalTarget) {
    const profileName = String(process.env.ZALOMASK_PROFILE_NAME || '').trim()
    const displayName = String(process.env.ZALOMASK_DISPLAY_NAME || profileName || '').trim()
    const cloneId = String(process.env.ZALOMASK_CLONE_ID || getCloneId() || '').trim()
    const record = buildCanonicalRecord(payload, profileName, displayName, cloneId)
    if (record) writeJsonAtomicSafe(canonicalTarget, record)
  }
}

function scheduleSnapshotPersist(payload) {
  // Snapshots arrive in bursts during page boot; debounce to avoid disk churn.
  if (snapshotSaveTimer) clearTimeout(snapshotSaveTimer)
  snapshotSaveTimer = setTimeout(() => {
    snapshotSaveTimer = null
    persistSnapshot(payload)
  }, SNAPSHOT_DEBOUNCE_MS)
}

function bootSessionSnapshotBridge() {
  try {
    ipcMain.on('zalomask:session-snapshot', (_event, payload) => {
      try { scheduleSnapshotPersist(payload) } catch {}
    })
  } catch {}
}

function startCloneAccountObservers() {
  for (const targetSession of getTrackedSessions()) {
    ensureCloneSessionPreload(targetSession)
    try { targetSession.cookies.on('changed', () => scheduleCookieSave()) } catch {}
  }

  app.on('browser-window-created', (_, win) => {
    // Identity is now seeded by the preload before any Zalo script runs, so
    // we just keep the cookie debounce wired up. No more executeJavaScript
    // race against the Zalo bundle.
    if (win) win.webContents.on('did-finish-load', () => scheduleCookieSave())
  })

  app.on('browser-window-focus', () => {
    scheduleCookieSave()
  })
}

applyCloneAppData()

if (getCloneId()) {
  const bootAccount = readCloneAccount()
  if (bootAccount) updateProcessCloneImei(bootAccount.imei || bootAccount.sessionIdentity?.zUuid || '')

  // The IPC bridge needs to be registered before any renderer is created;
  // that's why this runs synchronously at module load. The session/cookie
  // hydration still waits for app.ready.
  bootSessionSnapshotBridge()

  app.once('ready', async () => {
    await hydrateCloneAccountIfNeeded().catch(() => {})
    startCloneAccountObservers()
  })
}
