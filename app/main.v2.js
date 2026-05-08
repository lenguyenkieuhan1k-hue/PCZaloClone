'use strict'

const { app, BrowserWindow, ipcMain, dialog, session, shell, net } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const autoUpdate = require('./auto-update')

// In dev: __dirname = repo/app/, so .. = repo root (config.json lives there).
// In packaged: app.isPackaged = true; writable user data goes to userData,
// config.json is bundled as extraResources → process.resourcesPath/config.json.
const IS_PACKAGED = app.isPackaged
const ROOT_DIR = IS_PACKAGED ? app.getPath('userData') : path.resolve(__dirname, '..')
const CONFIG_PATH = IS_PACKAGED
  ? path.join(process.resourcesPath, 'config.json')
  : path.join(path.resolve(__dirname, '..'), 'config.json')
const PROFILES_DIR = path.join(ROOT_DIR, 'profiles')
const MAIN_HTML = path.join(__dirname, 'renderer', 'index-v2.html')
const MAIN_PRELOAD = path.join(__dirname, 'preload.js')
const WEB_PRELOAD = path.join(__dirname, 'web-preload-v2.js')
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'app-icon.png')
const ZALO_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const RUNTIME_LOG = path.join(ROOT_DIR, 'app-runtime.log')
const LICENSE_STATE_PATH = path.join(ROOT_DIR, 'license-state.json')
const APP_VERSION = safeReadJson(path.join(__dirname, 'package.json'), {})?.version || '0.0.0'

const webWindows = new Map()
const privacyMutators = new Map()

// Per-profile privacy: toggle Zalo Web "đang soạn / đã xem / đã nhận" feature on/off
// at the network layer. When a flag is on we drop the corresponding HTTP request
// before it leaves the renderer — Zalo client just sees the call as failed and
// moves on, and the server never receives the typing/seen/delivered signal.
//
// URL substring patterns (exact path match), case-insensitive. Adding new
// patterns here is safe — drop in any URL fragment Zalo adds in future builds.
const PRIVACY_URL_PATTERNS = {
  hideTyping:   ['/api/message/typing', '/api/group/typing'],
  hideSeen:     ['/api/message/seen', '/api/group/seen', '/api/message/seenv2', '/api/group/seenv2'],
  hideReceived: ['/api/message/delivered', '/api/group/delivered', '/api/message/deliveredv2', '/api/group/deliveredv2'],
}

function normalizeProfilePrivacy(input) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    hideTyping: !!src.hideTyping,
    hideSeen: !!src.hideSeen,
    hideReceived: !!src.hideReceived,
  }
}

function shouldBlockPrivacyUrl(url, privacy) {
  if (!url || !privacy) return false
  const lower = String(url).toLowerCase()
  for (const flag of Object.keys(PRIVACY_URL_PATTERNS)) {
    if (!privacy[flag]) continue
    for (const pattern of PRIVACY_URL_PATTERNS[flag]) {
      if (lower.includes(pattern)) return { flag, pattern }
    }
  }
  return false
}
const cookieSaveTimers = new Map()
const localStorageSeedCache = new Map()
const proxyCheckCache = new Map()
let licenseHeartbeatTimer = null

// Multi-key license cache: { license_id → { key, tier_id, account_quota, expires_at, status, active_session_id } }
// Updated periodically from web API.
//
// TTL note: heartbeat (30s) is the primary refresh trigger when online.
// LICENSE_CACHE_TTL_MS is the staleness ceiling when heartbeat is silent
// (offline / sleeping laptop / VPN dropping). When stale, getEffectiveProfileQuota
// fires a background sync but still serves the cached value so quota
// calculations don't block the UI.
const LICENSE_CACHE_TTL_MS = 60 * 60 * 1000  // 1 giờ
const activeLicensesCache = new Map()
let licensesCachedAt = 0
let bgSyncInFlight = false

function isLicenseCacheStale() {
  if (!licensesCachedAt) return true
  return (Date.now() - licensesCachedAt) > LICENSE_CACHE_TTL_MS
}

// Fire-and-forget cache refresh. Safe to call repeatedly; dedupes via
// bgSyncInFlight so we don't pile up on slow networks.
function triggerBackgroundLicenseSync(reason) {
  if (bgSyncInFlight) return
  const state = readLicenseState()
  if (!state?.key) return  // not activated, nothing to sync
  bgSyncInFlight = true
  syncLicensesFromWeb()
    .then((rs) => {
      logRuntime('license-bg-sync', { reason, ok: !!rs?.ok, message: rs?.message })
    })
    .catch((err) => {
      logRuntime('license-bg-sync-error', { reason, message: err?.message })
    })
    .finally(() => {
      bgSyncInFlight = false
    })
}

// Some Windows machines crash Electron renderers/GPU processes when loading Zalo Web.
app.disableHardwareAcceleration()
app.setAppUserModelId('com.zalomask.app')

function logRuntime(message, extra) {
  try {
    const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`
    fs.appendFileSync(RUNTIME_LOG, line, 'utf8')
  } catch (_) {
    // Ignore logging failures.
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return fallback
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function readLicenseState() {
  return safeReadJson(LICENSE_STATE_PATH, null)
}

function saveLicenseState(state) {
  writeJson(LICENSE_STATE_PATH, state || {})
}

function clearLicenseState() {
  try {
    if (fs.existsSync(LICENSE_STATE_PATH)) fs.unlinkSync(LICENSE_STATE_PATH)
  } catch (_) {}
}

function b64urlToBuffer(s) {
  const padded = String(s || '').replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(s || '').length % 4) % 4)
  return Buffer.from(padded, 'base64')
}

function verifyLicenseToken(token, publicKeyPem) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return { ok: false, message: 'Token sai định dạng' }
    const [headerB64, bodyB64, sigB64] = parts
    const message = Buffer.from(`${headerB64}.${bodyB64}`)
    const sig = b64urlToBuffer(sigB64)
    const pub = crypto.createPublicKey(publicKeyPem)
    const verified = crypto.verify(null, message, pub, sig)
    if (!verified) return { ok: false, message: 'Token signature không hợp lệ' }

    const payload = JSON.parse(b64urlToBuffer(bodyB64).toString('utf8'))
    if (!payload?.exp || payload.exp * 1000 < Date.now()) {
      return { ok: false, message: 'Token đã hết hạn' }
    }

    return { ok: true, payload }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không verify được token' }
  }
}

function makeDeviceFingerprint() {
  const hints = []
  try {
    const rg = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true })
    const txt = String(rg.stdout || '')
    const m = txt.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i)
    if (m && m[1]) hints.push(`mg:${m[1].trim()}`)
  } catch (_) {}

  try {
    const w = spawnSync('wmic', ['csproduct', 'get', 'UUID'], { encoding: 'utf8', windowsHide: true })
    const lines = String(w.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const val = lines.find((x) => /^[0-9a-fA-F-]{20,}$/.test(x))
    if (val) hints.push(`mb:${val}`)
  } catch (_) {}

  hints.push(`host:${os.hostname()}`)
  hints.push(`arch:${process.arch}`)
  hints.push(`platform:${process.platform}`)
  hints.push(`cpus:${os.cpus()?.length || 0}`)

  return crypto.createHash('sha256').update(hints.join('|')).digest('hex')
}

function countWebProfiles() {
  return listAllProfiles().length
}

function getEffectiveProfileQuota() {
  // Multi-key: sum all active licenses from cache
  const now = new Date()
  let totalQuota = 0
  let source = 'free'

  // Cache too old? Kick off a background refresh — never block the caller.
  if (isLicenseCacheStale()) {
    triggerBackgroundLicenseSync('quota-stale')
  }

  // Check if we have active licenses cached
  if (activeLicensesCache.size > 0) {
    let hasActive = false
    for (const [_licenseId, lic] of activeLicensesCache.entries()) {
      if (lic.status === 'active' && new Date(lic.expires_at) > now) {
        totalQuota += Number(lic.account_quota || 0)
        hasActive = true
        source = 'license'
      }
    }
    if (hasActive && totalQuota > 0) {
      return { quota: totalQuota, source, licenses: Array.from(activeLicensesCache.values()) }
    }
  }

  // Fallback to license-state.json (single key mode)
  const license = readLicenseState()
  if (license && String(license.status || '').toLowerCase() === 'active') {
    const licenseQuota = Number(license.accountQuota || 0)
    if (licenseQuota > 0) {
      return { quota: licenseQuota, source: 'license' }
    }
    return { quota: 0, source: 'license' }
  }
  return { quota: 1, source: 'free' }
}

function getLicenseConfig() {
  const cfg = readConfig()
  const baseUrl = String(cfg?.licenseApiBaseUrl || 'https://zalomask.com').trim().replace(/\/$/, '')
  const publicKeyPem = String(cfg?.licensePublicKeyPem || '').trim()
  const requireLicense = !!cfg?.requireLicense
  return { baseUrl, publicKeyPem, requireLicense }
}

async function postJson(url, payload, opts = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 12000)
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    const rs = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    })
    const json = await rs.json().catch(() => ({}))
    return { ok: rs.ok, status: rs.status, body: json }
  } finally {
    clearTimeout(t)
  }
}

async function getJson(url, opts = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 12000)
  try {
    const rs = await fetch(url, { method: 'GET', headers: { ...(opts.headers || {}) }, signal: controller.signal })
    const json = await rs.json().catch(() => ({}))
    return { ok: rs.ok, status: rs.status, body: json }
  } finally {
    clearTimeout(t)
  }
}

// Multi-key license sync: fetch all active licenses from web API
async function syncLicensesFromWeb() {
  const state = readLicenseState()
  if (!state?.key) return { ok: false, message: 'Chưa có license key' }

  const { baseUrl } = getLicenseConfig()
  const rs = await postJson(`${baseUrl}/api/electron/licenses`, { key: state.key })

  if (!rs.ok || !rs.body?.ok) {
    logRuntime('license-sync-failed', { status: rs.status, message: rs.body?.message })
    return { ok: false, message: rs.body?.message || 'Sync thất bại' }
  }

  // Update cache with all licenses from API
  activeLicensesCache.clear()
  const licenses = rs.body.licenses || []
  for (const lic of licenses) {
    activeLicensesCache.set(lic.license_id, lic)
  }
  licensesCachedAt = Date.now()

  logRuntime('license-sync-success', {
    totalLicenses: licenses.length,
    activeLicenses: licenses.filter((l) => l.status === 'active' && new Date(l.expires_at) > new Date()).length,
    totalQuota: rs.body.totalQuota,
    effectiveQuota: rs.body.effectiveQuota,
  })

  return { ok: true, licenses, totalQuota: rs.body.totalQuota, effectiveQuota: rs.body.effectiveQuota }
}

function broadcastLicenseStatus() {
  const state = readLicenseState() || {}
  mainWindow?.webContents.send('license-updated', state)
}

function stopLicenseHeartbeat() {
  if (licenseHeartbeatTimer) {
    clearInterval(licenseHeartbeatTimer)
    licenseHeartbeatTimer = null
  }
}

async function runHeartbeatOnce() {
  const state = readLicenseState()
  if (!state?.sessionId) return { ok: false, message: 'Chưa có session license' }
  
  // Multi-key: also sync licenses on heartbeat
  await syncLicensesFromWeb().catch((err) => {
    logRuntime('license-sync-on-heartbeat-error', { message: err?.message })
  })

  const { baseUrl } = getLicenseConfig()
  const rs = await postJson(`${baseUrl}/api/heartbeat`, { sessionId: state.sessionId })
  const status = String(rs?.body?.status || '')

  if (status === 'ok') {
    state.lastHeartbeatAt = new Date().toISOString()
    state.status = 'active'
    saveLicenseState(state)
    broadcastLicenseStatus()
    return { ok: true, status }
  }

  if (status === 'kicked' || status === 'expired') {
    state.status = status
    state.lastHeartbeatAt = new Date().toISOString()
    saveLicenseState(state)

    const message = status === 'kicked'
      ? 'License đang được dùng ở máy khác. App đã tự đóng để tránh xung đột.'
      : 'License của bạn đã hết hạn. Vui lòng gia hạn để tiếp tục dùng.'

    // Khi bị kicked: tự động upload cloud rồi xóa profile local.
    if (status === 'kicked') {
      try {
        const uploadRs = await runCloudUpload({ silent: true })
        logRuntime('cloud-auto-upload-on-kick', { ok: uploadRs?.ok, profiles: uploadRs?.profileCount })
      } catch (err) {
        logRuntime('cloud-auto-upload-on-kick-error', { message: err?.message })
      }
      try { wipeAllLocalProfiles() } catch (err) {
        logRuntime('cloud-auto-wipe-error', { message: err?.message })
      }
    }

    try {
      mainWindow?.webContents.send('license-kicked', { status, message, state })
    } catch (_) {}

    setTimeout(() => {
      for (const win of webWindows.values()) {
        try { if (win && !win.isDestroyed()) win.close() } catch (_) {}
      }
    }, 600)

    broadcastLicenseStatus()
    return { ok: false, status, message }
  }

  return { ok: false, status: 'unknown', message: rs?.body?.message || 'Heartbeat thất bại' }
}

function ensureLicenseHeartbeat() {
  stopLicenseHeartbeat()
  licenseHeartbeatTimer = setInterval(() => {
    runHeartbeatOnce().catch((error) => {
      logRuntime('license-heartbeat-error', { message: error?.message || 'unknown' })
    })
  }, 30000)
}

function getLicenseRuntimeStatus() {
  const state = readLicenseState() || {}
  const { requireLicense, baseUrl } = getLicenseConfig()
  const quotaRs = getEffectiveProfileQuota()
  const { quota, source } = quotaRs
  
  // Multi-key: include active licenses from cache
  const activeLicenses = quotaRs.licenses ? 
    quotaRs.licenses.map((lic) => ({
      license_id: lic.license_id,
      key_last4: String(lic.key || '').slice(-4),
      tier_id: lic.tier_id,
      account_quota: lic.account_quota,
      status: lic.status,
      expires_at: lic.expires_at,
    })) : []
  
  return {
    configured: true,
    apiBaseUrl: baseUrl,
    requireLicense,
    effectiveQuota: quota,
    quotaSource: source,
    state,
    activeLicenses,
    licensesCachedAt,
  }
}

function bootLicenseRuntime() {
  const state = readLicenseState() || {}
  broadcastLicenseStatus()

  // --- Boot-time config warnings (logged so dev/support can grep) ---
  const { publicKeyPem, baseUrl } = getLicenseConfig()
  if (!publicKeyPem) {
    logRuntime('config-warning', { kind: 'license-public-key-missing', message: 'config.json thiếu licensePublicKeyPem — tính năng License sẽ báo lỗi cho user.' })
  }
  try {
    const cfg = readConfig()
    const owner = String(cfg?.github?.owner || '').trim()
    const repo = String(cfg?.github?.repo || '').trim()
    if (!owner || !repo || /^REPLACE_/.test(owner) || /^REPLACE_/.test(repo)) {
      logRuntime('config-warning', { kind: 'github-placeholder', owner, repo, message: 'config.json.github.owner/repo còn placeholder — auto-update sẽ không tìm được release.' })
    }
    if (!baseUrl || baseUrl === 'https://zalomask.com') {
      // default OK; just note it
      logRuntime('config-info', { kind: 'license-api-base', baseUrl })
    }
  } catch (_) {}

  if (state?.sessionId && String(state.status || '').toLowerCase() === 'active') {
    // Multi-key: fetch licenses from web API on boot
    syncLicensesFromWeb().catch((error) => {
      logRuntime('license-sync-boot-error', { message: error?.message || 'unknown' })
    })

    ensureLicenseHeartbeat()
    runHeartbeatOnce().catch((error) => {
      logRuntime('license-heartbeat-boot-error', { message: error?.message || 'unknown' })
    })
    return
  }

  stopLicenseHeartbeat()
}

function readConfig() {
  return safeReadJson(CONFIG_PATH, {}) || {}
}

function writeConfig(next) {
  writeJson(CONFIG_PATH, next || {})
}

function profileDir(profileName) {
  return path.join(PROFILES_DIR, profileName)
}

function profileMetaPath(profileName) {
  return path.join(profileDir(profileName), 'meta.json')
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function uniqueProfileName(base) {
  const root = slugify(base) || 'profile'
  let name = root
  let i = 1
  while (fs.existsSync(profileMetaPath(name))) {
    i += 1
    name = `${root}_${i}`
  }
  return name
}

function listAllProfiles() {
  ensureDir(PROFILES_DIR)
  const names = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const items = []

  for (const name of names) {
    const meta = safeReadJson(profileMetaPath(name), null)
    if (!meta) continue

    // Legacy clone profiles are hidden in v2 runtime.
    if (meta.launchMode && meta.launchMode !== 'web' && meta.launchMode !== 'web2') continue

    const webSession = meta.webSession || {}
    items.push({
      profileName: name,
      displayName: meta.displayName || name,
      launchMode: 'web2',
      license_id: meta.license_id || '',  // Multi-key: license_id for partition isolation
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
      importedAt: meta.importedAt || null,
      zUuid: webSession.zUuid || '',
      cookieCount: Array.isArray(webSession.cookies) ? webSession.cookies.length : 0,
      localStorageCount: webSession.localStorage ? Object.keys(webSession.localStorage).length : 0,
      proxy: normalizeProxy(meta.proxy || {}),
      fingerprintId: normalizeFingerprint(meta.fingerprint || {}).id,
    })
  }

  items.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'vi'))
  return items
}

function loadProfileMeta(profileName) {
  return safeReadJson(profileMetaPath(profileName), null)
}

function saveProfileMeta(profileName, meta) {
  meta.updatedAt = new Date().toISOString()
  writeJson(profileMetaPath(profileName), meta)
}

function partitionFor(profileName, licenseId = '') {
  // Multi-key support: partition includes license_id for data isolation per key
  // Format: persist:zalomask-web-<licenseId>:<profileName>
  // Fallback for legacy profiles without license_id: persist:zalomask-web-<profileName>
  if (licenseId && licenseId.trim()) {
    return `persist:zalomask-web-${licenseId}:${profileName}`
  }
  // Legacy: profiles without license_id use simple partition
  return `persist:zalomask-web-${profileName}`
}

function decodeMaybeJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch (_) {
    return fallback
  }
}

function normalizeProxy(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const protocol = String(raw.protocol || 'HTTP').toUpperCase()
  const host = String(raw.host || '').trim()
  const portNum = Number(raw.port)
  const port = Number.isFinite(portNum) ? Math.trunc(portNum) : 0
  const authEnabled = !!raw.authEnabled
  const username = String(raw.username || '').trim()
  const password = String(raw.password || '')
  const enabled = !!raw.enabled && !!host && port > 0
  return {
    enabled,
    protocol: ['HTTP', 'HTTPS', 'SOCKS5'].includes(protocol) ? protocol : 'HTTP',
    host,
    port,
    authEnabled,
    username,
    password,
  }
}

function buildProxyRules(proxy) {
  const p = normalizeProxy(proxy)
  if (!p.enabled) return ''
  const scheme = p.protocol === 'SOCKS5' ? 'socks5' : 'http'
  return `${scheme}://${p.host}:${p.port}`
}

function buildSessionProxyConfig(proxy) {
  const rules = buildProxyRules(proxy)
  if (!rules) return { mode: 'direct' }
  return {
    mode: 'fixed_servers',
    proxyRules: rules,
    proxyBypassRules: '<-loopback>',
  }
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function generateFingerprint() {
  const version = randomInt(123, 136)
  const patch = `${randomInt(0, 9)}.${randomInt(0, 9999)}.${randomInt(0, 199)}`
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${patch} Safari/537.36`
  const languageSets = [
    ['vi-VN', 'vi', 'en-US', 'en'],
    ['en-US', 'en', 'vi-VN', 'vi'],
    ['vi-VN', 'en-US', 'en'],
  ]
  const timezones = [
    'Asia/Ho_Chi_Minh',
    'Asia/Bangkok',
    'Asia/Jakarta',
    'Asia/Singapore',
  ]
  const webglProfiles = [
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
    },
    {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0)',
    },
  ]
  const webgl = pickOne(webglProfiles)
  const id = crypto.randomBytes(8).toString('hex')
  return {
    id,
    version: 1,
    userAgent: ua,
    platform: 'Win32',
    vendor: 'Google Inc.',
    language: pickOne(languageSets)[0],
    languages: pickOne(languageSets),
    timezone: pickOne(timezones),
    hardwareConcurrency: pickOne([4, 6, 8, 12]),
    deviceMemory: pickOne([4, 8, 16]),
    maxTouchPoints: 0,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
  }
}

function normalizeFingerprint(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const fallback = generateFingerprint()
  const userAgent = String(raw.userAgent || '').trim() || fallback.userAgent
  const platform = String(raw.platform || '').trim() || 'Win32'
  const vendor = String(raw.vendor || '').trim() || 'Google Inc.'
  const language = String(raw.language || '').trim() || 'vi-VN'
  const languages = Array.isArray(raw.languages) && raw.languages.length
    ? raw.languages.map((x) => String(x || '').trim()).filter(Boolean)
    : [language, 'en-US', 'en']
  const timezone = String(raw.timezone || '').trim() || 'Asia/Ho_Chi_Minh'
  const hardwareConcurrency = Math.max(2, Math.min(24, Number(raw.hardwareConcurrency) || 8))
  const deviceMemory = Math.max(2, Math.min(32, Number(raw.deviceMemory) || 8))
  const maxTouchPoints = Math.max(0, Math.min(10, Number(raw.maxTouchPoints) || 0))
  const webglVendor = String(raw.webglVendor || '').trim() || 'Google Inc. (Intel)'
  const webglRenderer = String(raw.webglRenderer || '').trim() || 'ANGLE (Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)'
  const id = String(raw.id || '').trim() || fallback.id

  return {
    id,
    version: 1,
    userAgent,
    platform,
    vendor,
    language,
    languages,
    timezone,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints,
    webglVendor,
    webglRenderer,
  }
}

function checkProxyViaCurl(proxy) {
  const p = normalizeProxy(proxy)
  if (!p.enabled) return { ok: false, message: 'Proxy chưa đủ thông tin host/port' }

  const cacheKey = [p.protocol, p.host, p.port, p.authEnabled ? p.username : '', p.authEnabled ? p.password : ''].join('|')
  const cached = proxyCheckCache.get(cacheKey)
  if (cached && cached.ok && (Date.now() - cached.at) < 120000) {
    return { ok: true, ip: cached.ip, cached: true }
  }

  const scheme = p.protocol === 'SOCKS5' ? 'socks5h' : (p.protocol === 'HTTPS' ? 'https' : 'http')
  const proxyUrl = `${scheme}://${p.host}:${p.port}`
  const args = [
    '-sS',
    '--max-time', '8',
    '--connect-timeout', '5',
    '--proxy', proxyUrl,
    'https://api.ipify.org?format=json',
  ]

  if (p.authEnabled && p.username) {
    args.splice(args.length - 1, 0, '--proxy-user', `${p.username}:${p.password || ''}`)
  }

  try {
    const rs = spawnSync('curl.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const status = typeof rs.status === 'number' ? rs.status : 1
    const stdout = String(rs.stdout || '').trim()
    const stderr = String(rs.stderr || '').trim()

    if (status === 0) {
      try {
        const json = JSON.parse(stdout || '{}')
        if (json.ip) {
          proxyCheckCache.set(cacheKey, { ok: true, ip: json.ip, at: Date.now() })
          return { ok: true, ip: json.ip }
        }
      } catch (_) {}
      return { ok: false, message: 'Proxy phản hồi nhưng dữ liệu không hợp lệ' }
    }

    const errText = stderr || stdout || 'Không kết nối được proxy'
    return { ok: false, message: humanizeProxyError(errText) }
  } catch (error) {
    return { ok: false, message: humanizeProxyError(error?.message || 'Kiểm tra proxy thất bại') }
  }
}

function humanizeProxyError(rawMessage) {
  const text = String(rawMessage || '').trim()
  const low = text.toLowerCase()
  if (!text) return 'Không kết nối được proxy'
  if (low.includes('timed out') || low.includes('timeout')) return 'Proxy timeout: không phản hồi kịp thời gian chờ'
  if (low.includes('407')) return 'Proxy yêu cầu xác thực: sai username/password hoặc chưa cấp quyền'
  if (low.includes('could not resolve') || low.includes('name or service not known') || low.includes('dns')) {
    return 'Không phân giải được host proxy (DNS lỗi hoặc host sai)'
  }
  if (low.includes('refused')) return 'Proxy từ chối kết nối (connection refused)'
  if (low.includes('failed to connect') || low.includes('no route to host')) {
    return 'Không kết nối được tới server proxy (host/port có thể sai)'
  }
  if (low.includes('tunnel') && low.includes('failed')) return 'Lỗi tunnel qua proxy (thường do auth hoặc policy proxy)'
  if (low.includes('ssl') || low.includes('tls') || low.includes('handshake')) return 'Proxy kết nối được nhưng lỗi SSL/TLS handshake'
  return text.slice(0, 240)
}

function makeChecksumHex(payloadWithoutChecksum) {
  const json = JSON.stringify(payloadWithoutChecksum)
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex')
}

function withChecksum(payload) {
  const base = decodeMaybeJson(JSON.stringify(payload || {}), {})
  delete base.checksum
  return {
    ...base,
    checksum: {
      algo: 'sha256',
      value: makeChecksumHex(base),
    },
  }
}

function verifyChecksum(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Dữ liệu backup không hợp lệ' }
  const checksum = payload.checksum
  if (!checksum) return { ok: true }

  const algo = String(checksum.algo || '').toLowerCase()
  const value = String(checksum.value || '').trim().toLowerCase()
  if (algo !== 'sha256' || !value) return { ok: false, message: 'Checksum không hợp lệ' }

  const base = decodeMaybeJson(JSON.stringify(payload), {})
  delete base.checksum
  const actual = makeChecksumHex(base)
  if (actual !== value) return { ok: false, message: 'Checksum mismatch: file có thể đã bị sửa hoặc hỏng' }
  return { ok: true }
}

function bestCookieUrl(cookie) {
  const secure = cookie.secure !== false
  const protocol = secure ? 'https://' : 'http://'
  const rawDomain = String(cookie.domain || '').trim()
  const domain = rawDomain.replace(/^\./, '') || 'chat.zalo.me'
  const pathValue = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : `/${cookie.path || ''}`
  return `${protocol}${domain}${pathValue}`
}

async function seedCookiesForSession(ses, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return
  for (const row of cookies) {
    const name = String(row && row.name || '')
    if (!name) continue
    const payload = {
      url: bestCookieUrl(row),
      name,
      value: String(row.value || ''),
      path: String(row.path || '/'),
      secure: row.secure !== false,
      httpOnly: !!row.httpOnly,
      sameSite: row.sameSite || 'no_restriction',
    }
    if (typeof row.expirationDate === 'number' && Number.isFinite(row.expirationDate) && row.expirationDate > 0) {
      payload.expirationDate = row.expirationDate
    }
    if (row.domain) payload.domain = row.domain
    try {
      await ses.cookies.set(payload)
    } catch (_) {
      // Ignore malformed legacy cookie rows.
    }
  }
}

// Allow-list of cookie domains we transfer between machines. Anything outside
// this list is dropped to keep export payloads small + avoid leaking unrelated
// cookies (e.g. Google Analytics from .google.com that landed in this partition
// because of OAuth redirects).
const ZALO_COOKIE_DOMAIN_ALLOWLIST = ['zalo.me', 'zaloapp.com', 'zadn.vn']
function isZaloCookieDomain(domain) {
  const d = String(domain || '').toLowerCase()
  return ZALO_COOKIE_DOMAIN_ALLOWLIST.some((suffix) => d === suffix || d.endsWith('.' + suffix) || d === '.' + suffix)
}

async function getZaloCookies(ses) {
  const all = await ses.cookies.get({})
  return all.filter((c) => isZaloCookieDomain(c.domain))
}

function scheduleCookieSave(profileName, ses) {
  const old = cookieSaveTimers.get(profileName)
  if (old) clearTimeout(old)

  const timer = setTimeout(async () => {
    cookieSaveTimers.delete(profileName)
    const meta = loadProfileMeta(profileName)
    if (!meta) return

    try {
      const cookies = await getZaloCookies(ses)
      meta.webSession = meta.webSession || {}
      meta.webSession.cookies = cookies
      meta.webSession.cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      meta.webSession.cookieCapturedAt = new Date().toISOString()
      saveProfileMeta(profileName, meta)
      mainWindow?.webContents.send('profile-updated', profileName)
    } catch (_) {
      // Best effort save.
    }
  }, 1200)

  cookieSaveTimers.set(profileName, timer)
}

function normalizeImportedPayload(raw) {
  // New web format.
  if (raw && raw.format === 'zalomask-web-account') {
    const cookies = Array.isArray(raw.chromiumCookies) ? raw.chromiumCookies
      : Array.isArray(raw.cookies) ? raw.cookies
      : Array.isArray(raw?.webSession?.cookies) ? raw.webSession.cookies
      : []
    return {
      displayName: raw.displayName || raw.profileName || 'Imported Web',
      zUuid: raw.zUuid || raw?.webSession?.zUuid || raw?.session?.zUuid || '',
      localStorage: raw.localStorage || raw?.webSession?.localStorage || {},
      cookies,
      proxy: normalizeProxy(raw.proxy || {}),
      fingerprint: normalizeFingerprint(raw.fingerprint || {}),
      session: raw.session || raw?.webSession?.session || null,
      sourceFormat: raw.format,
    }
  }

  // Legacy clone export format.
  if (raw && raw.format === 'zalomask-clone-account' && raw.snapshot) {
    return {
      displayName: raw?.profile?.displayName || raw?.snapshot?.displayName || 'Imported Clone',
      zUuid: raw?.snapshot?.identity?.zUuid || '',
      localStorage: raw?.snapshot?.storage?.localStorage || {},
      cookies: Array.isArray(raw.cookies) ? raw.cookies : [],
      proxy: { enabled: false },
      fingerprint: generateFingerprint(),
      session: raw?.snapshot?.session || null,
      sourceFormat: raw.format,
    }
  }

  // Extension-like data fallback.
  const maybeAccount = raw?.account || raw?.data || raw
  const cookies = Array.isArray(maybeAccount?.cookies)
    ? maybeAccount.cookies
    : (Array.isArray(maybeAccount?.webSession?.cookies) ? maybeAccount.webSession.cookies : [])
  const localStorage = maybeAccount?.localStorage || maybeAccount?.webSession?.localStorage || maybeAccount?.storage?.localStorage || {}
  const zUuid = maybeAccount?.zUuid
    || maybeAccount?.webSession?.zUuid
    || maybeAccount?.session?.zUuid
    || localStorage?.z_uuid
    || localStorage?.sh_z_uuid
    || ''

  if (cookies.length > 0 || Object.keys(localStorage).length > 0) {
    return {
      displayName: maybeAccount?.displayName || maybeAccount?.profileName || maybeAccount?.me?.displayName || 'Imported Session',
      zUuid,
      localStorage,
      cookies,
      proxy: normalizeProxy(maybeAccount?.proxy || {}),
      fingerprint: normalizeFingerprint(maybeAccount?.fingerprint || {}),
      session: maybeAccount?.session || maybeAccount?.webSession?.session || null,
      sourceFormat: raw?.format || 'generic',
    }
  }

  return null
}

function normalizeImportedPayloads(raw) {
  if (raw && raw.format === 'zalomask-web-account-bundle' && Array.isArray(raw.accounts)) {
    return raw.accounts
      .map((item) => {
        const candidate = item && item.format
          ? item
          : { ...(item || {}), format: 'zalomask-web-account' }
        return normalizeImportedPayload(candidate)
      })
      .filter(Boolean)
  }

  const single = normalizeImportedPayload(raw)
  return single ? [single] : []
}

async function collectExportAccount(profileName) {
  const meta = loadProfileMeta(profileName)
  if (!meta) return null
  meta.fingerprint = normalizeFingerprint(meta.fingerprint || {})

  const ses = session.fromPartition(partitionFor(profileName, meta.license_id || ''))
  const liveCookies = await getZaloCookies(ses)
  if (liveCookies.length > 0) {
    meta.webSession = meta.webSession || {}
    meta.webSession.cookies = liveCookies
    meta.webSession.cookieString = liveCookies.map((c) => `${c.name}=${c.value}`).join('; ')
    meta.webSession.cookieCapturedAt = new Date().toISOString()
    saveProfileMeta(profileName, meta)
  } else {
    saveProfileMeta(profileName, meta)
  }

  // Live read from the Chromium partition is the source of truth — meta may
  // be slightly stale (debounced 1.2s save). Filtered against allow-list so
  // export only carries Zalo cookies, not random tracking ones.
  const chromiumCookies = liveCookies.length ? liveCookies : (meta?.webSession?.cookies || [])

  return {
    format: 'zalomask-web-account',
    version: 3,
    exportedAt: new Date().toISOString(),
    profileName,
    displayName: meta.displayName || profileName,
    zUuid: meta?.webSession?.zUuid || '',
    proxy: normalizeProxy(meta?.proxy || {}),
    fingerprint: normalizeFingerprint(meta?.fingerprint || {}),
    localStorage: meta?.webSession?.localStorage || {},
    // Both fields carry the same data — `cookies` for backward compat with
    // older importers, `chromiumCookies` is the explicit field name that
    // documents intent (Chromium partition cookies, not Zalo client cookies).
    cookies: chromiumCookies,
    chromiumCookies,
    session: meta?.webSession?.session || null,
  }
}

let mainWindow = null

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 880,
    minHeight: 620,
    show: false,
    frame: false,
    icon: APP_ICON,
    autoHideMenuBar: true,
    title: 'ZaloMask v2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: MAIN_PRELOAD,
    },
  })

  mainWindow.loadFile(MAIN_HTML)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logRuntime('main-window-render-gone', details)
  })
}

function profileNameFromWebContents(targetWebContents) {
  if (!targetWebContents) return null
  for (const [profileName, win] of webWindows.entries()) {
    if (!win || win.isDestroyed()) continue
    if (win.webContents === targetWebContents) return profileName
  }
  return null
}

app.on('login', (event, webContents, _request, authInfo, callback) => {
  if (!authInfo?.isProxy) return

  const profileName = profileNameFromWebContents(webContents)
  if (!profileName) return

  const meta = loadProfileMeta(profileName)
  const proxy = normalizeProxy(meta?.proxy || {})
  if (!proxy.enabled || !proxy.authEnabled || !proxy.username) return

  event.preventDefault()
  callback(proxy.username, proxy.password || '')
})

async function openWebProfile(profileName) {
  const meta = loadProfileMeta(profileName)
  if (!meta) throw new Error('Không tìm thấy profile')

  const existing = webWindows.get(profileName)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: true }
  }

  // Multi-key: use license_id from meta if available (new profiles)
  // Legacy profiles without license_id will use simple partition for backward compatibility
  const licenseId = meta.license_id || ''
  const partition = partitionFor(profileName, licenseId)
  const ses = session.fromPartition(partition)
  const webSession = meta.webSession || {}
  const profileProxy = normalizeProxy(meta.proxy || {})
  const fingerprint = normalizeFingerprint(meta.fingerprint || {})
  if (!meta.fingerprint || !meta.fingerprint.id) {
    meta.fingerprint = fingerprint
    saveProfileMeta(profileName, meta)
  }
  const localStorageSeed = decodeMaybeJson(JSON.stringify(webSession.localStorage || {}), {})
  localStorageSeedCache.set(profileName, localStorageSeed)

  // Proxy is mandatory when enabled: fail open if not usable.
  if (profileProxy.enabled) {
    const check = checkProxyViaCurl(profileProxy)
    if (!check.ok) {
      throw new Error(`Proxy không hoạt động: ${check.message || 'unknown'}`)
    }
  }

  try {
    await ses.setProxy(buildSessionProxyConfig(profileProxy))
  } catch (error) {
    if (profileProxy.enabled) {
      throw new Error(`Không áp được proxy cho profile: ${error?.message || 'unknown'}`)
    }
  }

  // -- Per-profile privacy filter --------------------------------------------
  // session.webRequest is global per-partition; setting onBeforeRequest with a
  // null listener clears it. We re-register with the latest privacy meta every
  // time the profile is opened, and again whenever set-profile-privacy IPC
  // fires for an open profile. The listener reads `currentPrivacy` from the
  // closure so a flag flip propagates without re-attaching anything.
  let currentPrivacy = normalizeProfilePrivacy(meta.privacy)
  ses.webRequest.onBeforeRequest({ urls: ['*://*.zalo.me/*', '*://*.zaloapp.com/*'] }, (details, callback) => {
    const hit = shouldBlockPrivacyUrl(details.url, currentPrivacy)
    if (hit) {
      // Cancel in-flight request. Zalo client treats it as a network blip,
      // recipient never sees the typing/seen/delivered signal.
      callback({ cancel: true })
      return
    }
    callback({ cancel: false })
  })
  // Stash the setter on webWindows entry so set-profile-privacy IPC can mutate
  // currentPrivacy without re-creating the BrowserWindow.
  privacyMutators.set(profileName, (next) => { currentPrivacy = normalizeProfilePrivacy(next) })

  const profileArg = `--zalomask-profile=${profileName}`
  const zUuidArg = `--zalomask-zuuid=${webSession.zUuid || ''}`

  const win = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 900,
    minHeight: 620,
    icon: APP_ICON,
    title: `Zalo Web - ${meta.displayName || profileName}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      preload: WEB_PRELOAD,
      additionalArguments: [profileArg, zUuidArg],
    },
  })

  // Zalo redirects Electron's default UA to the download page, so impersonate Chrome.
  win.webContents.setUserAgent(fingerprint.userAgent || ZALO_WEB_USER_AGENT)

  webWindows.set(profileName, win)

  win.webContents.on('render-process-gone', (_event, details) => {
    logRuntime('web-window-render-gone', { profileName, details })
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    logRuntime('web-window-did-fail-load', { profileName, errorCode, errorDescription, validatedURL })
  })

  const cookieChangedHandler = (_event, cookie, _cause, removed) => {
    if (removed) return
    const domain = String(cookie?.domain || '').toLowerCase()
    if (!domain.includes('zalo.me') && !domain.includes('zaloapp.com')) return
    scheduleCookieSave(profileName, ses)
  }
  ses.cookies.on('changed', cookieChangedHandler)

  win.on('closed', () => {
    webWindows.delete(profileName)
    privacyMutators.delete(profileName)
    localStorageSeedCache.delete(profileName)
    ses.cookies.removeListener('changed', cookieChangedHandler)
    const t = cookieSaveTimers.get(profileName)
    if (t) {
      clearTimeout(t)
      cookieSaveTimers.delete(profileName)
    }
  })

  const entryUrls = [
    'https://chat.zalo.me/',
    'https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F',
    'https://chat.zalo.me/?continue=1',
  ]

  let lastError = null
  for (const entryUrl of entryUrls) {
    try {
      await win.loadURL(entryUrl, { userAgent: fingerprint.userAgent || ZALO_WEB_USER_AGENT })
      lastError = null
      break
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) {
    throw lastError
  }

  scheduleCookieSave(profileName, ses)
  return { ok: true }
}

ipcMain.on('v2:web-session-snapshot', (_event, payload) => {
  const profileName = payload?.profileName
  if (!profileName) return

  const meta = loadProfileMeta(profileName)
  if (!meta) return

  const storage = decodeMaybeJson(JSON.stringify(payload?.localStorage || {}), {})
  const zUuid = payload?.zUuid || storage?.z_uuid || storage?.sh_z_uuid || meta?.webSession?.zUuid || ''

  meta.launchMode = 'web2'
  meta.webSession = meta.webSession || {}
  meta.webSession.localStorage = storage
  meta.webSession.zUuid = zUuid
  meta.webSession.storageCapturedAt = new Date().toISOString()
  if (payload?.reason) meta.webSession.lastReason = payload.reason
  saveProfileMeta(profileName, meta)

  mainWindow?.webContents.send('profile-updated', profileName)
})

ipcMain.on('v2:get-ls-seed', (event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) {
    event.returnValue = { ok: true, seed: {} }
    return
  }

  let seed = localStorageSeedCache.get(profileName)
  if (!seed) {
    const meta = loadProfileMeta(profileName)
    seed = decodeMaybeJson(JSON.stringify(meta?.webSession?.localStorage || {}), {})
  }

  event.returnValue = { ok: true, seed: seed && typeof seed === 'object' ? seed : {} }
})

ipcMain.on('v2:get-fingerprint-seed', (event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) {
    event.returnValue = { ok: true, fingerprint: normalizeFingerprint({}) }
    return
  }
  const meta = loadProfileMeta(profileName)
  const fp = normalizeFingerprint(meta?.fingerprint || {})
  if (meta && (!meta.fingerprint || !meta.fingerprint.id)) {
    meta.fingerprint = fp
    saveProfileMeta(profileName, meta)
  }
  event.returnValue = { ok: true, fingerprint: fp }
})

ipcMain.handle('list-profiles', async () => {
  return { ok: true, profiles: listAllProfiles() }
})

ipcMain.handle('get-profile-info', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }

  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }

  const ws = meta.webSession || {}
  return {
    ok: true,
    info: {
      profileName,
      displayName: meta.displayName || profileName,
      launchMode: meta.launchMode || 'web2',
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
      importedAt: meta.importedAt || null,
      zUuid: ws.zUuid || '',
      cookieCount: Array.isArray(ws.cookies) ? ws.cookies.length : 0,
      localStorageCount: ws.localStorage ? Object.keys(ws.localStorage).length : 0,
      proxy: normalizeProxy(meta.proxy || {}),
      fingerprint: normalizeFingerprint(meta.fingerprint || {}),
    },
  }
})

ipcMain.handle('launch-all', async () => {
  const profiles = listAllProfiles()
  const errors = []
  for (const profile of profiles) {
    try {
      await openWebProfile(profile.profileName)
    } catch (error) {
      errors.push(`${profile.displayName}: ${error?.message || 'unknown'}`)
    }
  }
  return {
    ok: errors.length === 0,
    count: profiles.length,
    message: errors.length ? errors.join(' | ') : `Đã mở ${profiles.length} profile`,
  }
})

ipcMain.handle('open-profiles-folder', async () => {
  ensureDir(PROFILES_DIR)
  const result = await shell.openPath(PROFILES_DIR)
  return { ok: result === '', message: result || '' }
})

ipcMain.handle('get-settings', async () => {
  const cfg = readConfig()
  const s = cfg?.settingsV2 || {}
  return {
    ok: true,
    settings: {
      hideTyping: !!s.hideTyping,
      hideSeen: !!s.hideSeen,
      hideReceived: !!s.hideReceived,
    },
  }
})

ipcMain.handle('set-setting', async (_event, payload) => {
  const key = String(payload?.key || '').trim()
  const allowed = new Set(['hideTyping', 'hideSeen', 'hideReceived'])
  if (!allowed.has(key)) return { ok: false, message: 'Khoá cài đặt không hợp lệ' }
  const cfg = readConfig()
  cfg.settingsV2 = cfg.settingsV2 || {}
  cfg.settingsV2[key] = !!payload?.value
  writeConfig(cfg)
  return { ok: true }
})

ipcMain.handle('get-system-health', async () => {
  const profiles = listAllProfiles()
  const info = {
    profileCount: profiles.length,
    webCount: profiles.length,
    cloneCount: 0,
    desktopCount: 0,
    appVersion: '2.0.0-web',
  }
  const warnings = []
  if (profiles.length === 0) warnings.push('Chưa có profile web nào')
  return { ok: true, info, warnings }
})

ipcMain.handle('get-license-status', async () => {
  return { ok: true, ...getLicenseRuntimeStatus() }
})

ipcMain.handle('sync-licenses', async () => {
  const rs = await syncLicensesFromWeb()
  if (rs.ok) {
    broadcastLicenseStatus()
  }
  return rs
})

ipcMain.handle('activate-license', async (_event, payload) => {
  const key = String(payload?.key || '').trim()
  if (!key) return { ok: false, message: 'Thiếu key kích hoạt' }

  // Multi-key: clear old cache on activate
  activeLicensesCache.clear()
  licensesCachedAt = 0

  const { baseUrl, publicKeyPem } = getLicenseConfig()
  if (!publicKeyPem) {
    return {
      ok: false,
      message:
        'App chưa được cấu hình production: thiếu licensePublicKeyPem trong config.json. ' +
        'Liên hệ admin/dev để dán Ed25519 public key vào file cấu hình.',
    }
  }

  const deviceFingerprint = makeDeviceFingerprint()
  const rs = await postJson(`${baseUrl}/api/activate`, {
    key,
    deviceFingerprint,
    deviceName: os.hostname(),
    appVersion: APP_VERSION,
  })

  if (!rs.ok || !rs.body?.ok) {
    return { ok: false, message: rs.body?.message || `Activate thất bại (HTTP ${rs.status})` }
  }

  const tokenRs = verifyLicenseToken(rs.body.token, publicKeyPem)
  if (!tokenRs.ok) return { ok: false, message: tokenRs.message }

  const next = {
    keyMasked: `${key.slice(0, 4)}...${key.slice(-4)}`,
    sessionId: String(rs.body.sessionId || ''),
    token: String(rs.body.token || ''),
    tokenPayload: tokenRs.payload,
    accountQuota: Number(rs.body.accountQuota || tokenRs.payload?.quota || 0),
    tokenExpiresAt: rs.body.expiresAt || null,
    licenseExpiresAt: rs.body.licenseExpiresAt || null,
    activatedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    status: 'active',
    deviceFingerprint,
  }

  saveLicenseState(next)
  
  // Multi-key: sync licenses immediately after activation
  await syncLicensesFromWeb().catch((err) => {
    logRuntime('license-sync-on-activate-error', { message: err?.message })
  })

  broadcastLicenseStatus()
  ensureLicenseHeartbeat()
  runHeartbeatOnce().catch(() => {})
  return { ok: true, state: next }
})

ipcMain.handle('deactivate-license', async () => {
  stopLicenseHeartbeat()
  clearLicenseState()
  broadcastLicenseStatus()
  return { ok: true }
})

ipcMain.handle('license-heartbeat', async () => {
  const { publicKeyPem } = getLicenseConfig()
  if (!publicKeyPem) {
    return { ok: false, message: 'App chưa được cấu hình production: thiếu licensePublicKeyPem trong config.json.' }
  }
  return runHeartbeatOnce()
})

ipcMain.handle('add-profile', async (_event, payload) => {
  try {
    const quotaRs = getEffectiveProfileQuota()
    const quota = Number(quotaRs.quota || 0)
    const used = countWebProfiles()

    if (quota > 0 && used >= quota) {
      if (quotaRs.source === 'free') {
        return { ok: false, message: 'Bản chưa kích hoạt chỉ dùng gói miễn phí (tối đa 1 profile). Kích hoạt key để mở thêm.' }
      }
      return { ok: false, message: `Đã đạt giới hạn gói hiện tại (${quota} profile)` }
    }

    const displayName = String(payload?.displayName || '').trim() || 'Zalo Web'
    const profileName = uniqueProfileName(displayName)
    
    // Multi-key support: assign a license_id to each profile
    // For local app: use a generated UUID (later can be linked to web license during sync)
    // Format stored in profile meta allows partition isolation per key
    const licenseId = crypto.randomUUID()
    
    const meta = {
      displayName,
      profileName,
      launchMode: 'web2',
      license_id: licenseId,  // New: multi-key support
      createdAt: new Date().toISOString(),
      proxy: normalizeProxy(payload?.proxy || {}),
      fingerprint: generateFingerprint(),
      webSession: {
        zUuid: '',
        localStorage: {},
        cookies: [],
        cookieString: '',
      },
    }

    saveProfileMeta(profileName, meta)
    await openWebProfile(profileName)
    return { ok: true, profileName, displayName, launchMode: 'web2', license_id: licenseId }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không tạo được profile web' }
  }
})

ipcMain.handle('open-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  try {
    // -- Issue #3: license-bound profile validation ---------------------
    // Profile mới sinh sau khi multi-key landing có gắn license_id. Nếu
    // license đó bị revoked/expired thì chặn mở. Profile legacy (không có
    // license_id) vẫn cho mở để backward compat.
    const meta = loadProfileMeta(profileName)
    if (meta?.license_id) {
      const lic = activeLicensesCache.get(meta.license_id)
      if (lic) {
        if (lic.status !== 'active') {
          logRuntime('open-profile-blocked', { profileName, licenseId: meta.license_id, status: lic.status })
          return { ok: false, message: 'License gắn với profile này đã ' + lic.status + '. Liên hệ admin nếu cần khôi phục.' }
        }
        if (new Date(lic.expires_at) < new Date()) {
          logRuntime('open-profile-blocked', { profileName, licenseId: meta.license_id, reason: 'expired' })
          return { ok: false, message: 'License gắn với profile này đã hết hạn. Vui lòng gia hạn.' }
        }
      } else {
        // Cache trống — có thể đang offline hoặc chưa sync xong. Cho mở
        // nhưng log lại + kích hoạt sync nền để lần sau bắt được.
        logRuntime('open-profile-license-not-in-cache', { profileName, licenseId: meta.license_id })
        triggerBackgroundLicenseSync('open-profile-cache-miss')
      }
    }

    await openWebProfile(profileName)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không mở được profile' }
  }
})

ipcMain.handle('update-proxy', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }

  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }

  meta.proxy = normalizeProxy(payload?.proxy || {})
  saveProfileMeta(profileName, meta)

  const ses = session.fromPartition(partitionFor(profileName, meta.license_id || ''))
  try {
    await ses.setProxy(buildSessionProxyConfig(meta.proxy))
  } catch (_) {
    // Ignore runtime apply errors.
  }

  return { ok: true, proxy: meta.proxy }
})

ipcMain.handle('get-profile-privacy', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }
  return { ok: true, privacy: normalizeProfilePrivacy(meta.privacy) }
})

ipcMain.handle('set-profile-privacy', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }
  const allowed = ['hideTyping', 'hideSeen', 'hideReceived']
  const key = String(payload?.key || '').trim()
  if (!allowed.includes(key)) return { ok: false, message: 'Key không hợp lệ' }
  meta.privacy = normalizeProfilePrivacy(meta.privacy)
  meta.privacy[key] = !!payload?.value
  saveProfileMeta(profileName, meta)
  // Live-apply for an already-open profile (no need to close + reopen window).
  const mutator = privacyMutators.get(profileName)
  if (mutator) mutator(meta.privacy)
  return { ok: true, privacy: meta.privacy, applied: !!mutator }
})

ipcMain.handle('check-proxy', async (_event, payload) => {
  return checkProxyViaCurl(payload?.proxy || payload || {})
})

function deleteProfileLocal(profileName) {
  if (!profileName) return
  const win = webWindows.get(profileName)
  if (win && !win.isDestroyed()) win.close()

  const dir = profileDir(profileName)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

ipcMain.handle('delete-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }

  deleteProfileLocal(profileName)
  return { ok: true }
})

ipcMain.handle('export-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  const payloadOut = await collectExportAccount(profileName)
  if (!payloadOut) return { ok: false, message: 'Không tìm thấy profile' }

  const suggested = `ZaloMask_${profileName}_${new Date().toISOString().slice(0, 10)}.json`
  const rs = await dialog.showSaveDialog({
    title: 'Xuất profile web',
    defaultPath: path.join(ROOT_DIR, suggested),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })

  if (!rs || rs.canceled || !rs.filePath) return { ok: false, message: 'Đã huỷ' }
  fs.writeFileSync(rs.filePath, JSON.stringify(withChecksum(payloadOut), null, 2), 'utf8')
  deleteProfileLocal(profileName)
  return { ok: true, filePath: rs.filePath, deletedProfile: profileName }
})

ipcMain.handle('export-profiles', async (_event, payload) => {
  const inputNames = Array.isArray(payload?.profileNames) ? payload.profileNames : []
  const profileNames = [...new Set(inputNames.map((x) => String(x || '').trim()).filter(Boolean))]
  if (profileNames.length === 0) return { ok: false, message: 'Chưa chọn profile để sao lưu' }

  const accounts = []
  for (const profileName of profileNames) {
    const account = await collectExportAccount(profileName)
    if (account) accounts.push(account)
  }

  if (accounts.length === 0) return { ok: false, message: 'Không có profile hợp lệ để sao lưu' }

  const suggested = `ZaloMask_backup_${new Date().toISOString().slice(0, 10)}.json`
  const rs = await dialog.showSaveDialog({
    title: 'Sao lưu nhiều profile web',
    defaultPath: path.join(ROOT_DIR, suggested),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })

  if (!rs || rs.canceled || !rs.filePath) return { ok: false, message: 'Đã huỷ' }

  const bundle = {
    format: 'zalomask-web-account-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: accounts.length,
    accounts,
  }

  fs.writeFileSync(rs.filePath, JSON.stringify(withChecksum(bundle), null, 2), 'utf8')
  for (const profileName of profileNames) {
    deleteProfileLocal(profileName)
  }
  return { ok: true, filePath: rs.filePath, count: accounts.length, deletedProfiles: profileNames }
})

ipcMain.handle('import-profile', async () => {
  try {
    const rs = await dialog.showOpenDialog({
      title: 'Nhập profile/session',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })

    if (!rs || rs.canceled || !rs.filePaths || rs.filePaths.length === 0) {
      return { ok: false, message: 'Đã huỷ' }
    }

    let raw
    try {
      raw = safeReadJson(rs.filePaths[0], null)
    } catch (_) {
      raw = null
    }
    if (!raw) return { ok: false, message: 'File JSON không hợp lệ' }

    const fileChecksum = verifyChecksum(raw)
    if (!fileChecksum.ok) return { ok: false, message: fileChecksum.message }

    if (raw?.format === 'zalomask-web-account-bundle' && Array.isArray(raw.accounts)) {
      for (let i = 0; i < raw.accounts.length; i += 1) {
        const itemChecksum = verifyChecksum(raw.accounts[i])
        if (!itemChecksum.ok) {
          return { ok: false, message: `Profile #${i + 1} lỗi checksum: ${itemChecksum.message}` }
        }
      }
    }

    const normalizedList = normalizeImportedPayloads(raw)
    if (normalizedList.length === 0) {
      return { ok: false, message: 'Không nhận diện được dữ liệu session trong file' }
    }

    const imported = []
    for (const normalized of normalizedList) {
      const profileName = uniqueProfileName(normalized.displayName)
      const meta = {
        displayName: normalized.displayName,
        profileName,
        launchMode: 'web2',
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        importSourceFormat: normalized.sourceFormat,
        proxy: normalizeProxy(normalized.proxy || {}),
        fingerprint: normalizeFingerprint(normalized.fingerprint || {}),
        webSession: {
          zUuid: normalized.zUuid || '',
          localStorage: normalized.localStorage || {},
          cookies: normalized.cookies || [],
          cookieString: (normalized.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '),
          session: normalized.session || null,
          seededAt: new Date().toISOString(),
        },
      }

      saveProfileMeta(profileName, meta)

      const ses = session.fromPartition(partitionFor(profileName, meta.license_id || ''))
      await ses.clearStorageData()
      await seedCookiesForSession(ses, normalized.cookies || [])
      imported.push({ profileName, displayName: meta.displayName })
    }

    if (imported.length > 0) {
      await openWebProfile(imported[0].profileName)
    }

    return {
      ok: true,
      profileName: imported[0]?.profileName || '',
      displayName: imported[0]?.displayName || '',
      launchMode: 'web2',
      count: imported.length,
      imported,
    }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không nhập được profile' }
  }
})

// ---------- Cloud sync helpers ----------

async function runCloudUpload({ silent = false } = {}) {
  const state = readLicenseState()
  if (!state?.sessionId || state.status !== 'active') {
    return { ok: false, message: 'Chưa kích hoạt license hoặc session không active.' }
  }
  const headers = state?.token ? { Authorization: `Bearer ${state.token}` } : {}
  const { baseUrl } = getLicenseConfig()
  ensureDir(PROFILES_DIR)
  const names = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  const profiles = names.map((n) => safeReadJson(profileMetaPath(n), null)).filter(Boolean)

  try {
    const rs = await postJson(`${baseUrl}/api/cloud-sync/upload`, {
      sessionId: state.sessionId,
      profiles,
    }, { headers })
    if (!silent) logRuntime('cloud-upload', { ok: rs?.body?.ok, count: profiles.length })
    return { ok: rs?.body?.ok === true, profileCount: profiles.length, message: rs?.body?.message }
  } catch (err) {
    return { ok: false, message: err?.message || 'Upload thất bại' }
  }
}

function wipeAllLocalProfiles() {
  ensureDir(PROFILES_DIR)
  const names = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  for (const name of names) {
    try { fs.rmSync(path.join(PROFILES_DIR, name), { recursive: true, force: true }) } catch (_) {}
  }
  logRuntime('cloud-wipe-local-profiles', { count: names.length })
}

// IPC: cloud-sync-upload (thủ công từ UI)
ipcMain.handle('cloud-sync-upload', async () => {
  return runCloudUpload()
})

// IPC: cloud-sync-download (máy B tải về)
ipcMain.handle('cloud-sync-download', async () => {
  const state = readLicenseState()
  if (!state?.sessionId || state.status !== 'active') {
    return { ok: false, message: 'Chưa kích hoạt license hoặc session không active.' }
  }
  const headers = state?.token ? { Authorization: `Bearer ${state.token}` } : {}
  const { baseUrl } = getLicenseConfig()
  try {
    const rs = await getJson(`${baseUrl}/api/cloud-sync/download?sessionId=${encodeURIComponent(state.sessionId)}`, { headers })
    if (!rs?.body?.ok) return { ok: false, message: rs?.body?.message || 'Download thất bại' }

    const profiles = Array.isArray(rs.body.profiles) ? rs.body.profiles : []
    ensureDir(PROFILES_DIR)
    let imported = 0
    for (const meta of profiles) {
      const name = meta.profileName
      if (!name) continue
      const dir = path.join(PROFILES_DIR, name)
      ensureDir(dir)
      writeJson(path.join(dir, 'meta.json'), { ...meta, updatedAt: new Date().toISOString() })

      // Seed Chromium partition cookies. Without this, the downloaded meta has
      // cookies recorded but Chromium's partition cookie store is empty so
      // chat.zalo.me would force a fresh QR scan.
      const cookies = Array.isArray(meta?.webSession?.chromiumCookies)
        ? meta.webSession.chromiumCookies
        : (Array.isArray(meta?.webSession?.cookies) ? meta.webSession.cookies : [])
      if (cookies.length > 0) {
        try {
          const ses = session.fromPartition(partitionFor(name, meta.license_id || ''))
          await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {})
          await seedCookiesForSession(ses, cookies)
        } catch (err) {
          logRuntime('cloud-download-seed-error', { profile: name, message: err?.message })
        }
      }
      imported++
    }
    logRuntime('cloud-download', { imported, uploadedAt: rs.body.uploadedAt })
    mainWindow?.webContents.send('profiles-reloaded')
    return { ok: true, imported, uploadedAt: rs.body.uploadedAt }
  } catch (err) {
    return { ok: false, message: err?.message || 'Download thất bại' }
  }
})

// IPC: cloud-sync-status (kiểm tra có backup chưa)
ipcMain.handle('cloud-sync-status', async () => {
  const state = readLicenseState()
  if (!state?.sessionId || state.status !== 'active') {
    return { ok: false, hasBackup: false, message: 'Chưa kích hoạt license.' }
  }
  const headers = state?.token ? { Authorization: `Bearer ${state.token}` } : {}
  const { baseUrl } = getLicenseConfig()
  try {
    const rs = await getJson(`${baseUrl}/api/cloud-sync/download?sessionId=${encodeURIComponent(state.sessionId)}`, { headers })
    if (!rs?.body?.ok) return { ok: false, hasBackup: false, message: rs?.body?.message || 'Cloud sync chưa sẵn sàng' }
    const count = rs.body.profileCount || 0
    return { ok: true, hasBackup: count > 0, profileCount: count, uploadedAt: rs.body.uploadedAt }
  } catch (err) {
    return { ok: false, hasBackup: false, message: err?.message }
  }
})

ipcMain.on('close-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
})

ipcMain.on('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
})

app.whenReady().then(() => {
  ensureDir(PROFILES_DIR)
  logRuntime('app-ready')
  createMainWindow()
  bootLicenseRuntime()
  try {
    autoUpdate.registerIpc({ configPath: CONFIG_PATH })
    autoUpdate.startBackgroundChecks({ configPath: CONFIG_PATH })
  } catch (error) {
    logRuntime('auto-update-boot-error', { message: error?.message || String(error) })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

process.on('uncaughtException', (error) => {
  logRuntime('uncaught-exception', { message: error?.message, stack: error?.stack })
})

process.on('unhandledRejection', (reason) => {
  logRuntime('unhandled-rejection', { reason: String(reason) })
})

app.on('render-process-gone', (_event, webContents, details) => {
  logRuntime('app-render-process-gone', { url: webContents?.getURL?.() || '', details })
})

app.on('child-process-gone', (_event, details) => {
  logRuntime('child-process-gone', details)
})

app.on('window-all-closed', () => {
  stopLicenseHeartbeat()
  if (process.platform !== 'darwin') app.quit()
})
