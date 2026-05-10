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
const { app, session, ipcMain } = require('electron')

const CLONE_ARG_PREFIX = '--appdata-id='
const CLONE_ENV_DIR = '__zalomask_clone_env__'
const CLONE_ACCOUNT_FILE = 'zalomask-account.json'
const CLONE_SEED_FILE = 'zalomask-seed.json'
const COOKIE_SAVE_DEBOUNCE_MS = 800
const SNAPSHOT_DEBOUNCE_MS = 600
const PRIVACY_CACHE_TTL_MS = 1000
const ZALO_COOKIE_HOSTS = ['.zalo.me', '.chat.zalo.me', '.zaloapp.com', '.zclient.zalo']
const CLONE_SESSION_PRELOAD_FILE = 'clone-session-preload.js'
const PRIVACY_URL_RULES = [
  {
    key: 'hideTyping',
    match: (url) => /(?:\/api\/.*\/typing|\/typing(?:v\d+)?|\btyping\b|is[_-]?typing|typing[_-]?status|composer(?:\/|$)|presence(?:\/|$)|\/chat\/typing)(?:\?|$|\/|\b)/i.test(url),
  },
  {
    key: 'hideSeen',
    match: (url) => /(?:\/api\/(?:message|group|conversation)\/(?:seen|seenv\d+|read|mark-read|read-receipt)|\/e2ee\/pc\/t\/(?:message|group)\/seen|(?:\b|[\/_-])(?:seen|read|read[_-]?receipt)(?:v\d+)?(?:\b|[\/_-]))(?:\?|$|\/)?/i.test(url),
  },
  {
    key: 'hideReceived',
    match: (url) => /(?:\/api\/(?:message|group|conversation)\/(?:delivered|deliveredv\d+|received|recv|ack|receipt)|\/e2ee\/pc\/t\/(?:message|group)\/delivered|(?:\b|[\/_-])(?:delivered|received|recv|ack|receipt)(?:v\d+)?(?:\b|[\/_-]))(?:\?|$|\/)?/i.test(url),
  },
]

let cloneDataRoot = ''
let pendingCloneImei = ''
let cookieSaveTimer = null
let snapshotSaveTimer = null
let lastSnapshotPayload = null
const privacyGuardInstalledSessions = new WeakSet()
let privacySettingsCache = {
  expiresAt: 0,
  value: {
    hideTyping: false,
    hideSeen: false,
    hideReceived: false,
  },
}

function writeCloneShimLoadedMarker() {
  try {
    const profileName = String(process.env.ZALOMASK_PROFILE_NAME || '').trim() || 'default'
    const cloneId = String(process.env.ZALOMASK_CLONE_ID || '').trim() || getCloneId() || ''
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    const outDir = path.join(programData, 'ZaloMask', 'privacy')
    try { fs.mkdirSync(outDir, { recursive: true }) } catch {}
    fs.writeFileSync(
      path.join(outDir, profileName + '.clone-shim-loaded.json'),
      JSON.stringify({
        loadedAt: new Date().toISOString(),
        profile: profileName,
        cloneId,
        version: 'clone-main-shim',
      }, null, 2),
      'utf8'
    )
  } catch {}
}

function getPrivacySettingsPath() {
  const profileName = String(process.env.ZALOMASK_PROFILE_NAME || '').trim() || 'default'
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  return path.join(programData, 'ZaloMask', 'privacy', profileName + '.json')
}

function readPrivacySettings() {
  if (Date.now() < privacySettingsCache.expiresAt) return privacySettingsCache.value
  try {
    const raw = fs.readFileSync(getPrivacySettingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    privacySettingsCache = {
      expiresAt: Date.now() + PRIVACY_CACHE_TTL_MS,
      value: {
        hideTyping: !!parsed.hideTyping,
        hideSeen: !!parsed.hideSeen,
        hideReceived: !!parsed.hideReceived,
      },
    }
  } catch {
    privacySettingsCache = {
      expiresAt: Date.now() + PRIVACY_CACHE_TTL_MS,
      value: {
        hideTyping: false,
        hideSeen: false,
        hideReceived: false,
      },
    }
  }
  return privacySettingsCache.value
}

function pickPrivacyRule(url) {
  if (!url) return null
  const settings = readPrivacySettings()
  return PRIVACY_URL_RULES.find((rule) => settings[rule.key] && rule.match(url)) || null
}

function decodeUploadDataToText(uploadData) {
  if (!Array.isArray(uploadData) || !uploadData.length) return ''
  const chunks = []
  for (const entry of uploadData) {
    if (!entry) continue
    if (entry.bytes) {
      try {
        if (Buffer.isBuffer(entry.bytes)) chunks.push(entry.bytes)
        else chunks.push(Buffer.from(entry.bytes))
      } catch {}
      continue
    }
    if (entry.file) {
      try {
        const body = fs.readFileSync(entry.file)
        if (body && body.length) chunks.push(body)
      } catch {}
    }
  }
  if (!chunks.length) return ''
  try { return Buffer.concat(chunks).toString('utf8') } catch { return '' }
}

function pickPrivacyRuleFromPayload(payloadText) {
  if (!payloadText) return null
  const settings = readPrivacySettings()
  const hay = String(payloadText)
  if (settings.hideTyping && /(?:\btyping\b|isTyping|is_typing|typing_status|\"type\"\s*:\s*\"typing\"|\"event\"\s*:\s*\"typing\"|\"composing\"\s*:\s*true)/i.test(hay)) {
    return { key: 'hideTyping' }
  }
  if (settings.hideSeen && /(?:\bseen\b|read_receipt|readReceipt|mark[_-]?read|\"seen\"\s*:|\"read\"\s*:|\"readAt\"\s*:)/i.test(hay)) {
    return { key: 'hideSeen' }
  }
  if (settings.hideReceived && /(?:\bdelivered\b|\breceived\b|\brecv\b|receipt|\"delivered\"\s*:|\"received\"\s*:|\"ack\"\s*:)/i.test(hay)) {
    return { key: 'hideReceived' }
  }
  return null
}

function ensurePrivacyRequestGuards(targetSession) {
  if (!targetSession || !targetSession.webRequest) return
  if (privacyGuardInstalledSessions.has(targetSession)) return
  try {
    targetSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const rule =
          pickPrivacyRule(String(details && details.url || '')) ||
          pickPrivacyRuleFromPayload(decodeUploadDataToText(details && details.uploadData))
        if (rule) {
          callback({ cancel: true })
          return
        }
      } catch {}
      callback({ cancel: false })
    })
    privacyGuardInstalledSessions.add(targetSession)
  } catch {}
}

function getCloneId() {
  // Prefer env (set by ZaloMask launcher) as a reliable source.
  const fromEnv = String(process.env.ZALOMASK_CLONE_ID || '').trim()
  if (fromEnv) return fromEnv
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

/** True for Windows directory junctions and symlinks. Node lstat reports both
 * as symbolic links since v12. We also defensively check the reparse-point
 * file attribute bit so older Node builds don't follow a junction by mistake. */
function isReparseEntry(p) {
  try {
    const lst = fs.lstatSync(p)
    if (lst.isSymbolicLink()) return true
    // Win32 FILE_ATTRIBUTE_REPARSE_POINT = 0x400. Node exposes it as `mode`'s
    // upper bits via `winattr`; check is best-effort and never throws.
    if (typeof lst.attrs === 'number' && (lst.attrs & 0x400) !== 0) return true
    return false
  } catch {
    return false
  }
}

/** Delete a junction/symlink WITHOUT following it. Critical: do NOT use
 * fs.rmSync({recursive:true}) here — on Windows it may walk through the
 * junction and delete the target's contents. */
function unlinkJunctionSafe(p) {
  try { fs.rmdirSync(p); return true } catch (_) {}
  try { fs.unlinkSync(p); return true } catch (_) {}
  return false
}

/** Recursively merge the contents of `srcDir` INTO `destDir` using rename when
 * possible (fast, atomic on the same volume) and falling back to copy+unlink.
 * Junctions/symlinks at any level are removed (link only, never their target)
 * because the shim re-creates them on every launch. */
function mergeDirectoryInto(srcDir, destDir) {
  let ents
  try { ents = fs.readdirSync(srcDir, { withFileTypes: true }) } catch { return }
  try { fs.mkdirSync(destDir, { recursive: true }) } catch {}
  for (const ent of ents) {
    const s = path.join(srcDir, ent.name)
    const d = path.join(destDir, ent.name)
    if (isReparseEntry(s)) {
      unlinkJunctionSafe(s)
      continue
    }
    if (ent.isDirectory()) {
      if (fs.existsSync(d)) {
        mergeDirectoryInto(s, d)
      } else {
        try { fs.renameSync(s, d) } catch { mergeDirectoryInto(s, d) }
      }
    } else {
      try {
        if (fs.existsSync(d)) { try { fs.unlinkSync(d) } catch {} }
        fs.renameSync(s, d)
      } catch {
        try { fs.copyFileSync(s, d) } catch {}
        try { fs.unlinkSync(s) } catch {}
      }
    }
  }
  try { fs.rmdirSync(srcDir) } catch {}
}

/** Detect & flatten a doubly-nested wrapper that earlier (buggy) shim runs
 * left behind. We move:
 *   wrapperRoot/CLONE_ENV_DIR/<cloneId>/X    →  wrapperRoot/X
 *   wrapperRoot/ZaloData_<cloneId>/X         →  cloneDataRoot/X        (the
 *      "true" cloneDataRoot at <baseAppData>/ZaloData_<cloneId>)
 * After this, all data lives at the singly-nested path the new idempotent
 * shim expects. */
function migrateDoublyNestedLayout(baseAppData, wrapperRoot, cloneId) {
  if (!cloneId || !wrapperRoot) return
  const innerWrapper = path.join(wrapperRoot, CLONE_ENV_DIR, cloneId)
  if (fs.existsSync(innerWrapper)) {
    try {
      mergeDirectoryInto(innerWrapper, wrapperRoot)
      // rmdirSync (non-recursive) — dir tree is empty by now. NEVER use
      // rmSync({recursive:true}) here: a stray junction would let Node walk
      // through it and delete the actual session data.
      try { fs.rmdirSync(path.join(wrapperRoot, CLONE_ENV_DIR)) } catch {}
    } catch {}
  }
  const innerCloneData = path.join(wrapperRoot, `ZaloData_${cloneId}`)
  const trueCloneData = path.join(baseAppData, `ZaloData_${cloneId}`)
  if (innerCloneData !== trueCloneData && fs.existsSync(innerCloneData)) {
    try {
      mergeDirectoryInto(innerCloneData, trueCloneData)
      try { fs.rmdirSync(innerCloneData) } catch {}
    } catch {}
  }
}

function applyCloneAppData() {
  const cloneId = getCloneId()
  if (!cloneId) return

  const baseAppData = process.env.APPDATA || app.getPath('appData')

  // Idempotency: if APPDATA already points to our per-clone wrapper, skip
  // re-wrapping. This prevents the doubly-nested layout that older builds
  // produced when the shim was loaded again in a child process / after
  // app.relaunch() (which inherits the parent's APPDATA env var).
  const expectedSuffix = path.sep + CLONE_ENV_DIR + path.sep + cloneId
  const normBase = String(baseAppData).replace(/[\\/]+/g, path.sep).replace(/[\\/]+$/, '')
  if (normBase.toLowerCase().endsWith(expectedSuffix.toLowerCase())) {
    const wrapperRoot = baseAppData
    const trueBase = path.dirname(path.dirname(wrapperRoot))
    cloneDataRoot = process.env.ZALOMASK_CLONE_DATA_ROOT || path.join(trueBase, `ZaloData_${cloneId}`)
    process.env.ZALOMASK_CLONE_ID = cloneId
    process.env.ZALOMASK_CLONE_DATA_ROOT = cloneDataRoot
    process.env.ZALOMASK_CLONE_SEED_PATH = path.join(cloneDataRoot, CLONE_SEED_FILE)
    try { app.setPath('appData', wrapperRoot) } catch {}
    try { app.setPath('userData', path.join(wrapperRoot, 'ElectronUserData')) } catch {}
    try { app.setPath('sessionData', path.join(wrapperRoot, 'ElectronSessionData')) } catch {}
    return
  }

  const wrapperRoot = path.join(baseAppData, CLONE_ENV_DIR, cloneId)
  cloneDataRoot = path.join(baseAppData, `ZaloData_${cloneId}`)

  fs.mkdirSync(cloneDataRoot, { recursive: true })
  fs.mkdirSync(wrapperRoot, { recursive: true })

  // ON-DISK MIGRATION (one-shot): older builds double-wrapped APPDATA, so
  // existing source profiles have their cookies/Local State at
  // wrapperRoot/__zalomask_clone_env__/<id>/ElectronSessionData. Flatten that
  // up to wrapperRoot/ElectronSessionData so the now-singly-wrapped Zalo can
  // read its own session.
  try { migrateDoublyNestedLayout(baseAppData, wrapperRoot, cloneId) } catch {}

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

function zalomaskForceExitFromTrayMenu() {
  try {
    app.exit(0)
  } catch (_) {
    try {
      process.exit(0)
    } catch (_) {}
  }
}

/**
 * Tray "Thoát" often calls app.quit() which Zalo can block via before-quit.
 * Patch menu templates once so quit items always follow with app.exit(0).
 * Scope: Windows clone only; only items that look like exit (label / role).
 */
function installTrayQuitMenuFollowThroughWin32() {
  if (process.platform !== 'win32') return
  try {
    const { Menu } = require('electron')
    if (!Menu || typeof Menu.buildFromTemplate !== 'function') return
    if (Menu.buildFromTemplate.__zalomaskTrayQuitPatch) return
    const original = Menu.buildFromTemplate.bind(Menu)

    function isTrayQuitItem(entry) {
      if (!entry || typeof entry !== 'object') return false
      if (entry.type === 'separator') return false
      if (entry.role === 'quit') return true
      const label = String(entry.label || '').trim().toLowerCase()
      if (!label) return false
      if (label === 'thoát' || label === 'exit' || label === 'quit') return true
      if (/^thoát\b/i.test(entry.label || '') && label.length < 40) return true
      return false
    }

    function patchItems(items) {
      if (!Array.isArray(items)) return items
      return items.map((item) => {
        if (!item || typeof item !== 'object') return item
        if (item.type === 'separator') return item
        const next = { ...item }
        if (Array.isArray(next.submenu)) {
          next.submenu = patchItems(next.submenu)
        }
        if (!isTrayQuitItem(next)) return next
        const prev = typeof next.click === 'function' ? next.click : null
        if (next.role === 'quit') {
          try {
            delete next.role
          } catch (_) {}
          // Electron MenuItem requires at least one of label, role, or type; Zalo may use { role: 'quit' } only.
          if (!next.label && !next.type) next.label = 'Quit'
        }
        next.click = function zalomaskPatchedTrayQuit(menuItem, browserWindow, event) {
          try {
            if (prev) prev.call(this, menuItem, browserWindow, event)
          } catch (_) {}
          setImmediate(() => zalomaskForceExitFromTrayMenu())
        }
        return next
      })
    }

    Menu.buildFromTemplate = function buildFromTemplatePatched(template) {
      return original(patchItems(template))
    }
    Menu.buildFromTemplate.__zalomaskTrayQuitPatch = true
  } catch (_) {}
}

function startCloneAccountObservers() {
  for (const targetSession of getTrackedSessions()) {
    ensureCloneSessionPreload(targetSession)
    ensurePrivacyRequestGuards(targetSession)
    try { targetSession.cookies.on('changed', () => scheduleCookieSave()) } catch {}
  }

  app.on('browser-window-created', (_, win) => {
    // Identity is now seeded by the preload before any Zalo script runs, so
    // we just keep the cookie debounce wired up. No more executeJavaScript
    // race against the Zalo bundle.
    if (win) {
      try { ensurePrivacyRequestGuards(win.webContents.session) } catch {}
      win.webContents.on('did-finish-load', () => scheduleCookieSave())
    }
  })

  app.on('browser-window-focus', () => {
    scheduleCookieSave()
  })
}

applyCloneAppData()

if (getCloneId()) {
  writeCloneShimLoadedMarker()
  const bootAccount = readCloneAccount()
  if (bootAccount) updateProcessCloneImei(bootAccount.imei || bootAccount.sessionIdentity?.zUuid || '')

  // The IPC bridge needs to be registered before any renderer is created;
  // that's why this runs synchronously at module load. The session/cookie
  // hydration still waits for app.ready.
  bootSessionSnapshotBridge()
  // After Zalo builds the tray context menu, quit items get a guaranteed app.exit(0).
  installTrayQuitMenuFollowThroughWin32()

  app.once('ready', async () => {
    await hydrateCloneAccountIfNeeded().catch(() => {})
    startCloneAccountObservers()
  })
}
