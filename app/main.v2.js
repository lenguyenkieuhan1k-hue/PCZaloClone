'use strict'

const { app, BrowserWindow, ipcMain, dialog, session, shell, net } = require('electron')
const { applyEarlyChromiumSwitches } = require('./chromium-win-bootstrap')
applyEarlyChromiumSwitches(app)
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const autoUpdate = require('./auto-update')
const cloneRuntime = require('./clone/clone-runtime')

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
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'app-icon.png')
const ZALO_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const RUNTIME_LOG = path.join(ROOT_DIR, 'app-runtime.log')
const LICENSE_STATE_PATH = path.join(ROOT_DIR, 'license-state.json')
const APP_VERSION = safeReadJson(path.join(__dirname, 'package.json'), {})?.version || '0.0.0'
const PORTABLE_PACKAGE_FORMAT = 'zalomask-portable-profile-bundle'
const LEGACY_PACKAGE_FORMAT = 'zalomask-desktop-profile-bundle'

function readStartupOpenProfileArg(argv = process.argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const text = String(arg || '')
    if (!text.startsWith('--zalomask-open-profile=')) continue
    const value = text.slice('--zalomask-open-profile='.length).trim().replace(/^"|"$/g, '')
    if (value) return value
  }
  return ''
}
const startupOpenProfileName = readStartupOpenProfileArg(process.argv)
const diagnosticsExportCliPath = readDiagnosticsExportArg(process.argv)

function readDiagnosticsExportArg(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const t = String(arg || '')
    if (t.startsWith('--zalomask-diagnostics=')) {
      return t.slice('--zalomask-diagnostics='.length).trim().replace(/^"|"$/g, '')
    }
  }
  return ''
}

function normalizeProfilePrivacy(input) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    hideTyping: !!src.hideTyping,
    hideSeen: !!src.hideSeen,
    hideReceived: !!src.hideReceived,
  }
}
const cookieSaveTimers = new Map()
const localStorageSeedCache = new Map()
const proxyCheckCache = new Map()
const deletingProfiles = new Set()
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

// Zalo PC bundle patch state — shared by boot + every launch path (open/import/add/launch-all).
let asarPatchState = null  // null = not attempted, { ok, message?, skipped?, reason? } = last result
let asarPatchPromise = null  // resolves when an in-flight patch attempt finishes

/** Ensure clone shim + privacy hooks are applied to bundled Zalo app.asar (deduped). */
async function ensurePcRuntimePatchReady(context = '') {
  if (!asarPatchPromise && (!asarPatchState || !asarPatchState.ok)) {
    asarPatchPromise = cloneRuntime.ensureAsarPatched((event, info) => logRuntime(event, info))
      .then((rs) => {
        asarPatchState = rs
        asarPatchPromise = null
      })
      .catch((err) => {
        asarPatchState = { ok: false, message: err?.message || String(err) }
        asarPatchPromise = null
      })
  }
  if (asarPatchPromise) await asarPatchPromise
  if (!asarPatchState || !asarPatchState.ok) {
    try {
      const st = await cloneRuntime.getRuntimeStatus()
      if (st && st.ok && st.patched) {
        logRuntime('asar-patch-failed-but-runtime-patched', {
          context: String(context || ''),
          message: asarPatchState?.message || 'unknown',
          asarPath: st.asarPath || '',
        })
        return { ok: true }
      }
    } catch (_) {}
    return {
      ok: false,
      message: 'Zalo runtime chưa được patch: ' + (asarPatchState?.message || 'unknown'),
    }
  }
  return { ok: true }
}

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

// Startup diagnostics: version + key writable paths.
try {
  logRuntime('app-version', {
    version: APP_VERSION,
    isPackaged: !!IS_PACKAGED,
    rootDir: ROOT_DIR,
    userData: (() => { try { return app.getPath('userData') } catch { return '' } })(),
  })
} catch (_) {}

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

function runPowerShellCommand(script, args = [], timeout = 10 * 60 * 1000) {
  const tempScriptPath = path.join(os.tmpdir(), `zalomask-ps-${Date.now()}-${crypto.randomUUID()}.ps1`)
  try {
    fs.writeFileSync(tempScriptPath, String(script || ''), 'utf8')
    const rs = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', tempScriptPath,
      ...args.map((value) => String(value ?? '')),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
    })
    if (rs.error) throw rs.error
    if (rs.status !== 0) {
      throw new Error(String(rs.stderr || rs.stdout || `PowerShell exited with code ${rs.status}`).trim())
    }
  } finally {
    try { if (fs.existsSync(tempScriptPath)) fs.unlinkSync(tempScriptPath) } catch (_) {}
  }
}

function runTarCommand(args = [], timeout = 10 * 60 * 1000) {
  const rs = spawnSync('tar.exe', Array.isArray(args) ? args.map((x) => String(x ?? '')) : [], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  })
  if (rs.error) throw rs.error
  if (rs.status !== 0) {
    throw new Error(String(rs.stderr || rs.stdout || `tar exited with code ${rs.status}`).trim())
  }
}

// Run PowerShell script file and capture result (for DPAPI debug paths).
function runPowerShellScriptWithResult(script, timeout = 15000) {
  const tempScriptPath = path.join(os.tmpdir(), `zm-ps-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.ps1`)
  try {
    fs.writeFileSync(tempScriptPath, String(script || ''), 'utf8')
    const rs = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', tempScriptPath,
    ], { encoding: 'utf8', windowsHide: true, timeout })
    return {
      ok: !rs.error && rs.status === 0,
      stdout: String(rs.stdout || '').trim(),
      stderr: String(rs.stderr || '').trim(),
      code: rs.status,
      error: rs.error || null,
    }
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: String(err?.message || err),
      code: -1,
      error: err,
    }
  } finally {
    try { if (fs.existsSync(tempScriptPath)) fs.unlinkSync(tempScriptPath) } catch (_) {}
  }
}

// Run PowerShell and return stdout string (or null on failure). Used for
// DPAPI operations that need output (cookie key extraction/application).
function runPowerShellCommandGetOutput(script, timeout = 15000) {
  const r = runPowerShellScriptWithResult(script, timeout)
  return r.ok ? r.stdout : null
}

/** True if this process is elevated (Run as administrator). DPAPI Unprotect for keys created by Zalo/Chromium under the normal user often fails from an elevated parent. */
function isWindowsElevatedSync() {
  if (process.platform !== 'win32') return false
  try {
    const rs = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::Out.Write([int]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    )
    return String(rs.stdout || '').trim() === '1'
  } catch (_) {
    return false
  }
}

// Extract the raw (decrypted) AES-256 cookie key from Chromium's Local State
// file at `localStatePath`. Returns base64 string of the raw 32-byte key, or
// null if not available / unsupported (e.g. non-Windows).
// Security note: the returned value is the plaintext AES key — treat as
// credential; store only inside the encrypted .zmb archive.
function extractChromiumCookieKey(localStatePath, ctx = {}) {
  try {
    if (!fs.existsSync(localStatePath)) return null
    const localState = safeReadJson(localStatePath, null)
    const encKeyB64 = localState?.os_crypt?.encrypted_key
    if (!encKeyB64) {
      if (localState?.os_crypt?.app_bound_encrypted_key) {
        logRuntime('export-cookie-key-no-dpapi-field', {
          ...ctx,
          localStatePath,
          hint: 'app-bound-key-present',
        })
      }
      return null
    }
    const withPrefix = Buffer.from(String(encKeyB64), 'base64')
    if (withPrefix.length <= 5) return null
    const magic4 = withPrefix.slice(0, 4).toString('ascii')
    const magic5 = withPrefix.slice(0, 5).toString('ascii')
    if (magic4 === 'APPB') {
      logRuntime('export-cookie-key-app-bound-prefix', { ...ctx, localStatePath })
      return null
    }
    if (!magic5.startsWith('DPAPI')) {
      logRuntime('export-cookie-key-unknown-prefix', {
        ...ctx,
        localStatePath,
        prefixSample: magic5.replace(/\0/g, '?'),
      })
      return null
    }
    // Chromium prepends the ASCII string "DPAPI" (5 bytes) before the DPAPI
    // ciphertext. Strip it before handing to ProtectedData.Unprotect.
    const dpapiBlobB64 = withPrefix.slice(5).toString('base64')
    const elevated = isWindowsElevatedSync()
    const psScript = `
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String('${dpapiBlobB64}')
$dec  = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
[Console]::WriteLine([Convert]::ToBase64String($dec))
`
    const r = runPowerShellScriptWithResult(psScript, 20000)
    if (!r.ok) {
      logRuntime('export-cookie-key-dpapi-unprotect-failed', {
        ...ctx,
        localStatePath,
        elevated,
        exitCode: r.code,
        stderr: (r.stderr || '').slice(0, 800),
      })
      return null
    }
    const out = r.stdout
    return out || null
  } catch (_) {
    return null
  }
}

// Patch `Local State` at `localStatePath` with a new DPAPI-protected version
// of the raw AES key `cookieKeyB64`. Called on the destination machine during
// import so Chromium can decrypt the cookies copied from the source machine.
function applyChromiumCookieKey(localStatePath, cookieKeyB64) {
  try {
    if (!localStatePath || !cookieKeyB64) return false
    if (!fs.existsSync(localStatePath)) return false
    const psScript = `
Add-Type -AssemblyName System.Security
$raw       = [Convert]::FromBase64String('${String(cookieKeyB64).trim()}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, 'CurrentUser')
[Console]::WriteLine([Convert]::ToBase64String($protected))
`
    const protectedB64 = runPowerShellCommandGetOutput(psScript, 12000)
    if (!protectedB64) return false
    const prefix = Buffer.from('DPAPI', 'ascii')
    const newEncKey = Buffer.concat([prefix, Buffer.from(protectedB64, 'base64')]).toString('base64')
    // Read + patch Local State in Node (avoid PowerShell JSON round-trip that
    // could corrupt Chromium-specific field ordering / large integer values).
    const raw = fs.readFileSync(localStatePath, 'utf8')
    const localState = JSON.parse(raw)
    if (!localState.os_crypt) localState.os_crypt = {}
    localState.os_crypt.encrypted_key = newEncKey
    fs.writeFileSync(localStatePath, JSON.stringify(localState), 'utf8')
    return true
  } catch (_) {
    return false
  }
}

function shortTempName(prefix, ext = '') {
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const safePrefix = String(prefix || 'zm').replace(/[^a-z0-9_-]/gi, '').slice(0, 8) || 'zm'
  return `${safePrefix}-${id}${ext}`
}

function compressDirectoryToArchive(sourceDir, archivePath) {
  const resolvedArchivePath = path.resolve(archivePath)
  const archiveDir = path.dirname(resolvedArchivePath)
  const archiveExt = path.extname(resolvedArchivePath).toLowerCase()
  const tempZip = archiveExt === '.zip'
    ? resolvedArchivePath
    : path.join(archiveDir, `${path.basename(resolvedArchivePath, archiveExt || undefined)}.zip`)
  try {
    ensureDir(archiveDir)
    try {
      if (fs.existsSync(tempZip)) fs.rmSync(tempZip, { force: true })
      if (resolvedArchivePath !== tempZip && fs.existsSync(resolvedArchivePath)) fs.rmSync(resolvedArchivePath, { force: true })
    } catch (_) {}
    const psCmd = "$src=\"$($args[0])\"; $dst=\"$($args[1])\"; if (-not (Test-Path $src -PathType Container)) { throw \"Source directory not found\" }; Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -Force -ErrorAction Stop"
    try {
      runPowerShellCommand(psCmd, [sourceDir, tempZip])
    } catch (error) {
      // PowerShell ZipArchive often fails on deep Windows paths, fallback to tar.exe zip mode.
      runTarCommand(['-a', '-c', '-f', tempZip, '-C', sourceDir, '.'])
      logRuntime('compress-archive-fallback-tar', {
        sourceDir,
        tempZip,
        reason: String(error?.message || 'powershell-compress-failed').slice(0, 500),
      })
    }
    if (!fs.existsSync(tempZip)) {
      throw new Error(`Compression failed: Archive not created at ${tempZip}`)
    }
    if (resolvedArchivePath !== tempZip) {
      fs.renameSync(tempZip, resolvedArchivePath)
    }
    if (!fs.existsSync(resolvedArchivePath)) {
      throw new Error(`Compression failed: Output file not created at ${resolvedArchivePath}`)
    }
  } finally {
    try { if (tempZip !== resolvedArchivePath && fs.existsSync(tempZip)) fs.unlinkSync(tempZip) } catch (_) {}
  }
}
function extractArchiveToDirectory(archivePath, destDir) {
  const tempZip = path.join(os.tmpdir(), shortTempName('zmi', '.zip'))
  ensureDir(destDir)
  try {
    fs.copyFileSync(archivePath, tempZip)
    try {
      runPowerShellCommand(
        "$src=$args[0]; $dst=$args[1]; Expand-Archive -Path $src -DestinationPath $dst -Force",
        [tempZip, destDir],
      )
    } catch (_) {
      runTarCommand(['-x', '-f', tempZip, '-C', destDir])
    }
  } finally {
    try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip) } catch (_) {}
  }
}

/** List file paths (POSIX, relative to rootDir) under a junction-free staged
 * profile directory. The export staging step (copyDirectoryFiltered) removes
 * junctions, so a plain walk produces paths identical to what Compress-Archive
 * stores in the .zmb. Skips reparse points defensively. */
function listRelativeFilesRecursive(rootDir) {
  const rootAbs = path.resolve(rootDir)
  const files = []
  function walk(curDir) {
    let entries
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const full = path.join(curDir, entry.name)
      if (isReparsePointEntry(full)) continue
      let st
      try {
        st = fs.statSync(full)
      } catch (_) {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (st.isFile()) {
        const rel = path.relative(rootAbs, full).replace(/\\/g, '/')
        files.push(rel)
      }
    }
  }
  walk(rootAbs)
  return files.sort((a, b) => a.localeCompare(b))
}

function sha256FileHex(filePath) {
  const st = fs.statSync(filePath)
  if (!st.isFile()) {
    throw new Error(`sha256FileHex: not a file (${filePath})`)
  }
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/** DFS for files with exact basename (case-insensitive), under rootDir. */
function findNamedFilesUnderDir(rootDir, baseName, maxDepth = 18) {
  const want = String(baseName || '').toLowerCase()
  const out = []
  if (!want || !rootDir || !fs.existsSync(rootDir)) return out
  function walk(dir, depth) {
    if (depth > maxDepth) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full, depth + 1)
      else if (String(ent.name || '').toLowerCase() === want) out.push(full)
    }
  }
  walk(rootDir, 0)
  return out
}

/** True = skip this relative path when exporting/importing portable profile copies (caches, telemetry). */
function shouldExcludeProfileExportPath(relPosixLower) {
  const lc = String(relPosixLower || '').replace(/\\/g, '/').toLowerCase()
  if (!lc || lc === '.') return false

  if (lc === 'meta.json' || lc.endsWith('/meta.json')) return false

  // Chat history DB shards — large; session/login does not need them for cross-machine restore.
  if (lc.includes('/database/_production/') && lc.includes('/core/message/')) return true

  const neverExcludeSubstrings = [
    '/network/cookies',
    '/local storage/',
    '/session storage/',
    '/indexeddb/',
    '/databases/',
  ]
  for (const s of neverExcludeSubstrings) {
    if (lc.includes(s)) return false
  }
  // Other SQLite under Zalo Database (Index, Encrypt, …) — keep unless matched above.
  if (lc.includes('/database/')) return false
  if (lc.endsWith('/local state')) return false
  if (lc.endsWith('/preferences')) return false
  if (lc.endsWith('/z_u.txt')) return false
  if (/\/zalodata\/config\.json$/i.test(lc)) return false
  if (/\/zalodata\/[^/]+\.db(-wal|-shm)?$/i.test(lc)) return false

  if (lc === 'appdata/local' || lc.startsWith('appdata/local/')) return true

  const parts = lc.split('/').filter(Boolean)
  const skipSegments = new Set([
    'cache',
    'code cache',
    'gpucache',
    'grshadercache',
    'dawncache',
    'dawngraphitecache',
    'dawnwebgpucache',
    'shadercache',
    'blob_storage',
    'crashpad',
    'browsermetrics',
    'component_crx_cache',
    'optimization_guide_model_store',
    'shared_dictionary',
    'extensions',
    'serviceworker',
    'service worker',
    'jump list icons',
    'videodecoding',
    'videodecodestats',
    'hyphen-data',
    'scriptcache',
    'tls_certificate_suffix',
    'webrtc_logs',
    'mediafoundationwidevinecdm',
    'widevinecdm',
    'subresource filter',
    'trust tokens',
    'network logs',
    'safe browsing',
    'reporting and nel',
    'media cache',
    'background_sync',
    'background synchronization',
    'sessions',
    'commerce_subscription_db',
    'discounts_db',
    'coupon_db',
    'discount_infos_db',
    'optimization_hints',
    'parcel_tracking_db',
    'chrome_cart_db',
    'budgetdatabase',
    'feature_engagement_tracker',
    'persistentorigintrials',
    'segmentation_platform',
    'heavy ad intervention',
    'webrtc_event_logs',
    'download service',
    'prefetches',
    'ads_service',
    'topics_store',
    'interest_groups',
    'private_aggregation',
    'shared_proto_db',
    'sync_app_settings',
    'autofill',
    'autofill strike database',
    'history',
    'web data',
    'login data',
    'favicons',
    'quota_manager',
    'platform_notifications',
    'network action predictor',
    'optimization_guide_hint_cache_store',
  ])

  for (const part of parts) {
    if (skipSegments.has(part)) return true
  }
  return false
}

/** True for Windows directory junctions / symlinks (reparse points). Node ≥ 12 reports junctions as symlinks. */
function isReparsePointEntry(absPath) {
  try {
    const st = fs.lstatSync(absPath)
    if (st.isSymbolicLink()) return true
  } catch (_) {}
  return false
}

/** Recursive copy that:
 *  - skips junctions/symlinks (PowerShell Compress-Archive doesn't follow them, so manifest must not include their contents either),
 *  - skips pid.txt,
 *  - skips heavy cache/telemetry segments via shouldExcludeProfileExportPath. */
function copyDirectoryFiltered(srcDir, destDir) {
  const root = path.resolve(srcDir)

  function walk(curSrc, curDst) {
    let entries
    try {
      entries = fs.readdirSync(curSrc, { withFileTypes: true })
    } catch (_) {
      return
    }
    let createdDst = false
    for (const entry of entries) {
      const childSrc = path.join(curSrc, entry.name)
      const childDst = path.join(curDst, entry.name)
      const baseLc = String(entry.name || '').toLowerCase()
      if (baseLc === 'pid.txt') continue

      // Skip Windows junctions / symlinks. Compress-Archive cannot follow them
      // and on Zalo PC clone layout each junction (e.g. ZaloData) points to a
      // sibling real directory we'll visit on its own.
      if (isReparsePointEntry(childSrc)) continue

      let stat
      try {
        stat = fs.statSync(childSrc)
      } catch (_) {
        continue
      }

      const relRaw = path.relative(root, childSrc).replace(/\\/g, '/')
      const relLc = relRaw.toLowerCase()

      if (stat.isDirectory()) {
        // Honor exclusion rules for directory segments (cache, history, …)
        if (shouldExcludeProfileExportPath(relLc + '/')) continue
        walk(childSrc, childDst)
        continue
      }
      if (!stat.isFile()) continue

      if (shouldExcludeProfileExportPath(relLc)) continue

      if (!createdDst) {
        fs.mkdirSync(curDst, { recursive: true })
        createdDst = true
      }
      try {
        fs.copyFileSync(childSrc, childDst)
      } catch (err) {
        logRuntime('export-copy-file-failed', {
          rel: relRaw,
          message: String(err?.message || err).slice(0, 200),
        })
      }
    }
  }

  fs.mkdirSync(destDir, { recursive: true })
  walk(root, path.resolve(destDir))
}

function listFilesSafe(dir) {
  try {
    return fs.readdirSync(dir)
  } catch (_) {
    return []
  }
}

const CLONE_ENV_DIR_NAME = '__zalomask_clone_env__'

/** Delete a Windows junction/symlink WITHOUT following it. NEVER use
 * fs.rmSync({recursive:true}) on a junction — Node may walk through it and
 * delete the target's contents. */
function unlinkJunctionLinkOnly(p) {
  try { fs.rmdirSync(p); return true } catch (_) {}
  try { fs.unlinkSync(p); return true } catch (_) {}
  return false
}

/** Recursively merge `srcDir` INTO `destDir` (rename when possible, copy as
 * fallback). Junctions/symlinks at any level are unlinked (link only, never
 * their target). Used to flatten older buggy doubly-nested clone layouts. */
function mergeDirectoryInto(srcDir, destDir, stats) {
  let ents
  try { ents = fs.readdirSync(srcDir, { withFileTypes: true }) } catch { return }
  try { fs.mkdirSync(destDir, { recursive: true }) } catch {}
  for (const ent of ents) {
    const s = path.join(srcDir, ent.name)
    const d = path.join(destDir, ent.name)
    if (isReparsePointEntry(s)) {
      unlinkJunctionLinkOnly(s)
      if (stats) stats.skippedJunctions = (stats.skippedJunctions || 0) + 1
      continue
    }
    if (ent.isDirectory()) {
      if (fs.existsSync(d)) {
        mergeDirectoryInto(s, d, stats)
      } else {
        try { fs.renameSync(s, d) } catch { mergeDirectoryInto(s, d, stats) }
      }
    } else {
      try {
        if (fs.existsSync(d)) { try { fs.unlinkSync(d) } catch {} }
        fs.renameSync(s, d)
      } catch {
        try { fs.copyFileSync(s, d) } catch {}
        try { fs.unlinkSync(s) } catch {}
      }
      if (stats) stats.movedFiles = (stats.movedFiles || 0) + 1
    }
  }
  try { fs.rmdirSync(srcDir) } catch {}
}

/** Some older builds of the clone shim wrapped APPDATA twice, so packages and
 * source profiles ended up with cookies / Local State at
 *   __zalomask_clone_env__/<id>/__zalomask_clone_env__/<id>/ElectronSessionData/...
 * (a doubly-nested layout). The fixed shim wraps APPDATA exactly once and reads
 * cookies from the singly-nested path, so we have to flatten any doubly-nested
 * data we encounter at export and import time. Returns stats. */
function flattenDoublyNestedClone(profileRoot, cloneId) {
  const stats = { flattenedWrappers: 0, flattenedDataDirs: 0, movedFiles: 0, skippedJunctions: 0 }
  if (!cloneId || !profileRoot) return stats
  const roaming = path.join(profileRoot, 'AppData', 'Roaming')
  if (!fs.existsSync(roaming)) return stats

  const wrapperRoot = path.join(roaming, CLONE_ENV_DIR_NAME, cloneId)
  if (!fs.existsSync(wrapperRoot)) return stats

  // Flatten wrapperRoot/__zalomask_clone_env__/<cloneId>/* up to wrapperRoot/*.
  const innerWrapper = path.join(wrapperRoot, CLONE_ENV_DIR_NAME, cloneId)
  if (fs.existsSync(innerWrapper)) {
    mergeDirectoryInto(innerWrapper, wrapperRoot, stats)
    // Use rmdirSync (non-recursive) — by now the dir tree is empty. NEVER use
    // rmSync({recursive:true}) at the wrapper level; if any leftover junction
    // survived we'd traverse into the actual data directory.
    try { fs.rmdirSync(path.join(wrapperRoot, CLONE_ENV_DIR_NAME)) } catch {}
    stats.flattenedWrappers += 1
  }

  // Flatten wrapperRoot/ZaloData_<cloneId>/* up to <roaming>/ZaloData_<cloneId>/* (the
  // "true" cloneDataRoot the singly-wrapped shim uses).
  const innerCloneData = path.join(wrapperRoot, `ZaloData_${cloneId}`)
  const trueCloneData = path.join(roaming, `ZaloData_${cloneId}`)
  if (innerCloneData !== trueCloneData && fs.existsSync(innerCloneData)) {
    mergeDirectoryInto(innerCloneData, trueCloneData, stats)
    try { fs.rmdirSync(innerCloneData) } catch {}
    stats.flattenedDataDirs += 1
  }
  return stats
}

/** Rename PC clone folders that embed the source profile's cloneId so the imported
 * data lines up with the new profile's cloneId-derived APPDATA layout. Walks
 * bottom-up to avoid invalidating paths still on the stack. Returns counters. */
function renameCloneIdFolders(profileRoot, oldCloneId, newCloneId) {
  const stats = { renamedDirs: 0, renamedFiles: 0, errors: 0 }
  if (!oldCloneId || !newCloneId || oldCloneId === newCloneId) return stats
  if (!fs.existsSync(profileRoot)) return stats

  const dirs = []
  const files = []
  function gather(curDir) {
    let entries
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of entries) {
      const full = path.join(curDir, ent.name)
      if (ent.isDirectory()) {
        dirs.push(full)
        gather(full)
      } else if (ent.isFile()) {
        if (ent.name.includes(oldCloneId)) files.push(full)
      }
    }
  }
  gather(profileRoot)

  for (const filePath of files) {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const newBase = base.split(oldCloneId).join(newCloneId)
    if (newBase === base) continue
    try {
      fs.renameSync(filePath, path.join(dir, newBase))
      stats.renamedFiles += 1
    } catch (err) {
      stats.errors += 1
      logRuntime('import-rename-file-failed', {
        from: filePath,
        message: String(err?.message || err).slice(0, 200),
      })
    }
  }

  // Deepest first so we never rename a parent before its children.
  dirs.sort((a, b) => b.length - a.length)
  for (const d of dirs) {
    const base = path.basename(d)
    if (!base.includes(oldCloneId)) continue
    // Only touch the cloneId itself and the ZaloData_<cloneId> sibling. The
    // literal folder __zalomask_clone_env__ does NOT contain the cloneId, so
    // we won't accidentally rename it. Account-id-bearing names (e.g.
    // ftsm_<accountId>.db) use the Zalo account, not cloneId, so they're
    // untouched.
    if (base !== oldCloneId && base !== `ZaloData_${oldCloneId}`) continue
    const newBase = base.split(oldCloneId).join(newCloneId)
    const newPath = path.join(path.dirname(d), newBase)
    try {
      if (fs.existsSync(newPath)) {
        // Target already exists — usually leftover from a previous failed
        // rename. Remove it so renameSync doesn't throw EEXIST on Windows.
        fs.rmSync(newPath, { recursive: true, force: true })
      }
      fs.renameSync(d, newPath)
      stats.renamedDirs += 1
    } catch (err) {
      stats.errors += 1
      logRuntime('import-rename-dir-failed', {
        from: d,
        to: newPath,
        message: String(err?.message || err).slice(0, 200),
      })
    }
  }
  return stats
}

function assessImportedDesktopProfile(profileName, profileRoot, extras = {}) {
  const roaming = path.join(profileRoot, 'AppData', 'Roaming')
  const roamingZaloData = path.join(roaming, 'ZaloData')
  const localStatePaths = findNamedFilesUnderDir(roaming, 'local state', 22)
  const cookieMainPaths = findNamedFilesUnderDir(roaming, 'cookies', 22).filter((full) => {
    const x = full.replace(/\\/g, '/').toLowerCase()
    return x.endsWith('/network/cookies')
  })
  const prefPaths = findNamedFilesUnderDir(roaming, 'preferences', 22).filter((full) => {
    const x = full.replace(/\\/g, '/').toLowerCase()
    return x.endsWith('/preferences')
  })
  let hasCookiesWal = false
  for (const cp of cookieMainPaths) {
    const wal = `${cp}-wal`
    try {
      if (fs.existsSync(wal)) hasCookiesWal = true
    } catch (_) {}
  }

  let hasCookiesDb = false
  for (const cp of cookieMainPaths) {
    try {
      if (fs.statSync(cp).size > 0) hasCookiesDb = true
    } catch (_) {}
  }

  let hasLocalStorageLeveldb = false
  function spotLevelDb(dir, depth) {
    if (hasLocalStorageLeveldb || depth > 20) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    const dirLc = dir.replace(/\\/g, '/').toLowerCase()
    const inLsLeveldb = dirLc.includes('/local storage/leveldb')
    for (const ent of ents) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) spotLevelDb(full, depth + 1)
      else if (inLsLeveldb && /\.(ldb|log)$/i.test(ent.name)) hasLocalStorageLeveldb = true
    }
  }
  if (fs.existsSync(roaming)) spotLevelDb(roaming, 0)

  let hasDatabaseFiles = false
  function spotDb(dir, depth) {
    if (hasDatabaseFiles || depth > 22) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) spotDb(full, depth + 1)
      else if (/\.db(-wal|-shm)?$/i.test(ent.name)) hasDatabaseFiles = true
    }
  }
  if (fs.existsSync(roaming)) spotDb(roaming, 0)

  const checks = {
    hasZaloDataDir: fs.existsSync(roamingZaloData)
      || localStatePaths.length > 0
      || cookieMainPaths.length > 0,
    hasLocalState: localStatePaths.length > 0,
    hasPreferences: prefPaths.length > 0,
    hasCookiesDb,
    hasCookiesWal,
    hasLocalStorageLeveldb,
    hasDatabaseFiles,
  }

  // cookieKeyApplied tri-state:
  //   true  → DPAPI re-protect ran successfully on this machine
  //   false → key was present in package but DPAPI re-protect failed
  //   null  → no key in package (legacy export or extract failed at source)
  const cookieKeyApplied = (extras && Object.prototype.hasOwnProperty.call(extras, 'cookieKeyApplied'))
    ? extras.cookieKeyApplied
    : null

  const passed = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length
  const score = Math.round((passed / total) * 100)
  const likelyRestored = checks.hasZaloDataDir
    && checks.hasCookiesDb
    && checks.hasLocalStorageLeveldb
    && cookieKeyApplied !== false

  const hints = []
  if (!checks.hasZaloDataDir) hints.push('Không thấy dữ liệu Roaming (ZaloData hoặc ElectronSessionData clone)')
  else {
    if (!checks.hasLocalState) hints.push('Thiếu Local State (khóa mã hoá cookie của Chromium)')
    if (!checks.hasPreferences) hints.push('Thiếu Preferences')
    if (!checks.hasCookiesDb) hints.push('Thiếu Network/Cookies hoặc file rỗng')
    if (!checks.hasCookiesWal) hints.push('Không có Cookies-wal (thường vẫn OK nếu Cookies đã checkpoint)')
    if (!checks.hasLocalStorageLeveldb) hints.push('Thiếu Local Storage/leveldb (.ldb/.log)')
    if (!checks.hasDatabaseFiles) hints.push('Chưa thấy file .db trong snapshot')
  }
  if (cookieKeyApplied === false) {
    hints.push('Không áp được khóa cookie (DPAPI) trên máy này — thử chạy app không Admin / cùng user Windows')
  }
  if (cookieKeyApplied === null) {
    hints.push('Backup không có cookieKey trong package — cùng máy có thể vẫn vào được; sang máy khác thường phải đăng nhập lại')
  }

  return {
    profileName,
    score,
    likelyRestored,
    checks,
    cookieKeyApplied,
    hints,
  }
}

function buildExportableProfileMetaSnapshot(profileName, meta) {
  const src = meta && typeof meta === 'object' ? meta : {}
  return {
    profileName: String(profileName || '').trim(),
    displayName: String(src.displayName || profileName || '').trim() || String(profileName || ''),
    launchMode: 'pc',
    proxy: normalizeProxy(src.proxy || {}),
    fingerprint: normalizeFingerprint(src.fingerprint || {}),
    privacy: normalizeProfilePrivacy(src.privacy || {}),
    createdAt: src.createdAt || null,
  }
}

/** Walk Roaming for Chromium `Local State` (PC clone uses __zalomask_clone_env__/…/ElectronSessionData/). */
function extractPortableProfileCookieKeyB64(profileRoot, ctx = {}) {
  const roaming = path.join(profileRoot, 'AppData', 'Roaming')
  const lsPaths = findNamedFilesUnderDir(roaming, 'local state', 22)
  lsPaths.sort((a, b) => {
    const pa = a.replace(/\\/g, '/').toLowerCase()
    const pb = b.replace(/\\/g, '/').toLowerCase()
    const rank = (p) => (p.includes('/partitions/zalo/') ? 0 : p.includes('/electronsessiondata/') ? 1 : 2)
    const d = rank(pa) - rank(pb)
    return d !== 0 ? d : pa.length - pb.length
  })
  for (const lsPath of lsPaths) {
    const key = extractChromiumCookieKey(lsPath, ctx)
    if (key) return key
  }
  return null
}

function buildDesktopPackageManifestEntry(profileName, stagedProfileDir, meta, options = {}) {
  const mode = String(options.mode || 'portable')
  const files = listRelativeFilesRecursive(stagedProfileDir).flatMap((relPath) => {
    const full = path.join(stagedProfileDir, relPath)
    let stat
    try {
      stat = fs.statSync(full)
    } catch (_) {
      return []
    }
    if (!stat.isFile()) return []
    return [{
      path: relPath,
      size: stat.size,
      sha256: sha256FileHex(full),
    }]
  })
  const totalSize = files.reduce((sum, item) => sum + Number(item.size || 0), 0)
  const criticalFiles = files.filter((x) => isCriticalProfileFilePath(x.path))
  const volatileFiles = files.filter((x) => isVolatileProfileFilePath(x.path))
  // Extract Chromium AES cookie key (DPAPI unwrap on source). Clone layout stores
  // Local State under …/ElectronSessionData/, not only Roaming/ZaloData/.
  const extractCtx = { profileName }
  let cookieKeyB64 = extractPortableProfileCookieKeyB64(stagedProfileDir, extractCtx) || undefined
  if (!cookieKeyB64 && options.sourceProfileDir) {
    cookieKeyB64 = extractPortableProfileCookieKeyB64(options.sourceProfileDir, extractCtx) || undefined
  }
  if (!cookieKeyB64) {
    const roaming = path.join(stagedProfileDir, 'AppData', 'Roaming')
    logRuntime('export-cookie-key-missing', {
      profileName,
      elevated: isWindowsElevatedSync(),
      localStateFilesFound: findNamedFilesUnderDir(roaming, 'local state', 22).length,
    })
  }

  return {
    profileName,
    displayName: meta?.displayName || profileName,
    launchMode: 'pc',
    cloneId: meta?.cloneId || '',
    metaSnapshot: buildExportableProfileMetaSnapshot(profileName, meta),
    relativeRoot: `profiles/${profileName}`,
    fileCount: files.length,
    totalSize,
    mode,
    criticalFiles,
    volatileFiles,
    files: mode === 'legacy' ? files : undefined,
    // Raw AES-256 key (base64). Present only when DPAPI decrypt succeeded on
    // the source machine. Import step will re-DPAPI-protect this for the
    // destination user so Chromium cookies remain readable cross-machine.
    cookieKeyB64,
  }
}

function isVolatileProfileFilePath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').toLowerCase()
  if (!p) return false
  if (/\/cache\//i.test(p)) return true
  if (/\/code cache\//i.test(p)) return true
  if (/\/gpucache\//i.test(p)) return true
  if (/\/dawncache\//i.test(p)) return true
  // LevelDB active write-ahead log — replayed/compacted on next open. Must be
  // present (so we copy it) but its checksum is allowed to drift between
  // snapshot and verify, so we mark it volatile. The actual .ldb data files
  // are critical (see isCriticalProfileFilePath below).
  if (/\/local storage\/leveldb\/.*\.log$/i.test(p)) return true
  if (/\/session storage\/.*\.log$/i.test(p)) return true
  if (/\/network\/networkdatamigrated$/i.test(p)) return true
  if (/\/network\/network persistent state$/i.test(p)) return true
  if (/\/network\/transportsecurity$/i.test(p)) return true
  // SQLite journal sidecars (-journal, -wal, -shm). Treated as volatile so
  // checksum drift between snapshot and verify doesn't fail the import; the
  // copy step still includes them so Chromium can auto-merge on first open.
  if (/\/network\/.*-(journal|wal|shm)$/i.test(p)) return true
  if (/\/network\/cookies-(journal|wal|shm)$/i.test(p)) return true
  if (/\.(db-wal|db-shm)$/i.test(p)) return true
  if (/(^|\/)lock(file)?$/i.test(p)) return true
  if (/(^|\/)current$/i.test(p)) return true
  if (/(^|\/)log(\.old)?$/i.test(p)) return true
  return false
}

function isCriticalProfileFilePath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').toLowerCase()
  if (!p) return false
  if (p === 'meta.json') return true
  if (p.endsWith('/z_u.txt') && p.includes('/roaming/')) return true
  // Chromium user-data root or partition (PC clone: ElectronSessionData / Partitions/zalo / …).
  if (p.endsWith('/local state')) return true
  if (p.endsWith('/preferences')) return true
  if (p.endsWith('/network/cookies')) return true
  // LevelDB sealed data files — verify strictly; active .log stays volatile.
  if (/\/local storage\/leveldb\/[^/]+\.ldb$/i.test(p)) return true
  // Zalo SQLite — keep Index/Encrypt/etc.; Message shards omitted from export (large).
  if (p.includes('/database/')) {
    if (p.includes('/core/message/')) return false
    return true
  }
  if (/\/zalodata\/[^/]+\.db(-wal|-shm)?$/i.test(p)) return true
  return false
}

function verifyDesktopPackageManifest(manifest, extractedRoot) {
  const format = String(manifest?.format || '')
  if (!manifest || (format !== PORTABLE_PACKAGE_FORMAT && format !== LEGACY_PACKAGE_FORMAT)) {
    return { ok: false, message: 'Manifest package desktop không hợp lệ' }
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
    return { ok: false, message: 'Package không chứa profile nào' }
  }

  const warnings = []
  const isPortable = format === PORTABLE_PACKAGE_FORMAT

  for (const profile of manifest.profiles) {
    const baseDir = path.join(extractedRoot, ...(String(profile.relativeRoot || '').split('/').filter(Boolean)))
    if (!fs.existsSync(baseDir)) {
      return { ok: false, message: `Thiếu thư mục profile trong package: ${profile.relativeRoot || profile.profileName}` }
    }

    // For portable format, verify critical files strictly and volatile files leniently
    const entriesToVerify = isPortable
      ? [
        ...(Array.isArray(profile.criticalFiles) ? profile.criticalFiles.map(f => ({ ...f, critical: true })) : []),
        ...(Array.isArray(profile.volatileFiles) ? profile.volatileFiles.map(f => ({ ...f, critical: false })) : []),
      ]
      : (Array.isArray(profile.files) ? profile.files.map(f => ({ ...f, critical: true })) : [])

    if (entriesToVerify.length === 0) {
      return { ok: false, message: `Package thiếu danh sách file xác minh cho profile: ${profile.profileName || 'unknown'}` }
    }

    for (const file of entriesToVerify) {
      const full = path.join(baseDir, ...(String(file.path || '').split('/').filter(Boolean)))
      const isCritical = file.critical === true
      const isVolatile = isVolatileProfileFilePath(file.path)

      if (!fs.existsSync(full)) {
        if (!isCritical) {
          warnings.push({ profileName: profile.profileName, path: file.path, reason: 'missing-volatile' })
          continue
        }
        return { ok: false, message: `Thiếu file trong package: ${profile.profileName}/${file.path}` }
      }

      const stat = fs.statSync(full)
      if (!stat.isFile()) {
        if (!isCritical) {
          warnings.push({
            profileName: profile.profileName,
            path: file.path,
            reason: 'verify-skipped-not-a-file',
          })
          continue
        }
        return { ok: false, message: `Không phải file trong package: ${profile.profileName}/${file.path}` }
      }
      if (Number(file.size || -1) !== stat.size) {
        // Volatile files (WAL, log, sidecars) may change size between snapshot and verify.
        // Skip strict verification for volatile files regardless of critical status.
        if (isVolatile) {
          warnings.push({
            profileName: profile.profileName,
            path: file.path,
            reason: 'size-mismatch-volatile-allowed',
            expectedSize: Number(file.size || -1),
            actualSize: stat.size,
          })
          continue
        }
        if (!isCritical) {
          warnings.push({
            profileName: profile.profileName,
            path: file.path,
            reason: 'size-mismatch-noncritical',
            expectedSize: Number(file.size || -1),
            actualSize: stat.size,
          })
          continue
        }
        // Log chi tiết file bị size mismatch (critical + not volatile)
        logRuntime('import-verify-size-mismatch', {
          profileName: profile.profileName,
          filePath: file.path,
          expectedSize: Number(file.size || -1),
          actualSize: stat.size,
          isCritical,
          isVolatile,
        })
        return { ok: false, message: `Sai dung lượng file: ${profile.profileName}/${file.path} (kỳ vọng ${Number(file.size || -1)} bytes, có ${stat.size} bytes)` }
      }

      if (String(file.sha256 || '').toLowerCase() !== sha256FileHex(full)) {
        // Skip checksum verification for volatile files.
        if (isVolatile) {
          warnings.push({
            profileName: profile.profileName,
            path: file.path,
            reason: 'checksum-mismatch-volatile-allowed',
          })
          continue
        }
        if (!isCritical) {
          warnings.push({
            profileName: profile.profileName,
            path: file.path,
            reason: 'checksum-mismatch-noncritical',
          })
          continue
        }
        return { ok: false, message: `Checksum mismatch: ${profile.profileName}/${file.path}` }
      }
    }
  }

  return { ok: true, warnings }
}

async function exportDesktopProfilesArchive(profileNames, options = {}) {
  const names = [...new Set((profileNames || []).map((x) => String(x || '').trim()).filter(Boolean))]
  if (names.length === 0) return { ok: false, message: 'Chưa chọn profile để sao lưu' }
  logRuntime('export-desktop-profiles-start', { profileNames: names, count: names.length })

  const suggested = options.suggestedName || `ZaloMask_backup_${new Date().toISOString().slice(0, 10)}.zmb`
  const dialogTitle = options.dialogTitle || (names.length === 1 ? 'Xuất profile desktop' : 'Sao lưu nhiều profile desktop')
  const rs = await dialog.showSaveDialog({
    title: dialogTitle,
    defaultPath: path.join(ROOT_DIR, suggested),
    filters: [{ name: 'Zalo Portable Backup', extensions: ['zmb', 'zlp', 'zip'] }],
  })
  if (!rs || rs.canceled || !rs.filePath) return { ok: false, message: 'Đã huỷ' }

  const tempRoot = path.join(os.tmpdir(), shortTempName('zme'))
  const profilesRoot = path.join(tempRoot, 'profiles')
  ensureDir(profilesRoot)

  try {
    const exportElevated = isWindowsElevatedSync()
    const manifestProfiles = []
    for (const profileName of names) {
      const meta = loadProfileMeta(profileName)
      if (!meta) continue
      const srcDir = profileDir(profileName)
      if (!fs.existsSync(srcDir)) continue

      const terminateRs = await cloneRuntime.terminatePcProfile(profileName, {
        profileDir: srcDir,
        logger: (event, info) => logRuntime(event, info),
      })
      logRuntime('pc-profile-terminate-before-export', { profileName, ...terminateRs })
      if (!terminateRs.ok) {
        logRuntime('export-desktop-profiles-failed', { profileName, reason: terminateRs.reason, executablePath: terminateRs.executablePath || '' })
        return { ok: false, message: `Không thể sao lưu ${profileName}: ${terminateRs.reason || 'profile đang bận'}` }
      }

      const stagedDir = path.join(profilesRoot, profileName)
      try {
        copyDirectoryFiltered(srcDir, stagedDir)
      } catch (error) {
        logRuntime('export-desktop-profiles-copy-failed', { profileName, message: error?.message || 'IO error' })
        return { ok: false, message: `Không thể đọc dữ liệu ${profileName}: ${error?.message || 'IO error'}` }
      }

      // Flatten any doubly-nested clone wrapper data created by older builds
      // so the exported package matches the singly-nested layout the fixed
      // shim expects on the destination machine. Without this, an old source
      // profile (with wrapperRoot/__zalomask_clone_env__/<id>/ElectronSessionData)
      // would be unreadable on a freshly-installed destination.
      const cloneIdForExport = String(meta?.cloneId || cloneRuntime.cloneIdFor(profileName)).trim()
      if (cloneIdForExport) {
        const fs2 = flattenDoublyNestedClone(stagedDir, cloneIdForExport)
        if (fs2.flattenedWrappers || fs2.flattenedDataDirs) {
          logRuntime('export-flatten-doubly-nested', { profileName, cloneId: cloneIdForExport, ...fs2 })
        }
      }

      manifestProfiles.push(buildDesktopPackageManifestEntry(profileName, stagedDir, meta, {
        mode: 'portable',
        sourceProfileDir: srcDir,
      }))
    }

    if (manifestProfiles.length === 0) return { ok: false, message: 'Không có profile hợp lệ để sao lưu' }

    const manifest = withChecksum({
      format: PORTABLE_PACKAGE_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      backupEngine: 'portable-snapshot',
      count: manifestProfiles.length,
      profiles: manifestProfiles,
    })
    writeJson(path.join(tempRoot, 'manifest.json'), manifest)
    compressDirectoryToArchive(tempRoot, rs.filePath)
    const profilesMissingCookieKey = manifestProfiles
      .filter((p) => !String(p.cookieKeyB64 || '').trim())
      .map((p) => p.profileName)
    logRuntime('export-desktop-profiles-success', {
      filePath: rs.filePath,
      count: manifestProfiles.length,
      profileNames: manifestProfiles.map((x) => x.profileName),
      profilesMissingCookieKey,
      exportElevated,
    })
    return {
      ok: true,
      filePath: rs.filePath,
      count: manifestProfiles.length,
      profileNames: manifestProfiles.map((x) => x.profileName),
      profilesMissingCookieKey,
      exportElevated,
    }
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch (_) {}
  }
}

async function importDesktopProfilesArchive(archivePath, opts = {}) {
  const tempRoot = path.join(os.tmpdir(), shortTempName('zmi'))
  ensureDir(tempRoot)
  try {
    extractArchiveToDirectory(archivePath, tempRoot)
    const manifest = safeReadJson(path.join(tempRoot, 'manifest.json'), null)
    if (!manifest) return { ok: false, message: 'Package không có manifest.json hợp lệ' }
    const manifestChecksum = verifyChecksum(manifest)
    if (!manifestChecksum.ok) return manifestChecksum
    const manifestVerify = verifyDesktopPackageManifest(manifest, tempRoot)
    if (!manifestVerify.ok) return manifestVerify
    const verifyWarnings = Array.isArray(manifestVerify.warnings) ? manifestVerify.warnings : []

    // Quota gate: import is the same business action as add-profile and must
    // honor the user's effective quota. Without this the free tier (1 profile)
    // can be bypassed by importing a package that has multiple profiles. The
    // cloud-sync download path passes `bypassQuota: true` because that flow
    // is gated server-side by the active license session.
    if (!opts.bypassQuota) {
      const incoming = Array.isArray(manifest.profiles) ? manifest.profiles.length : 0
      const quotaRs = getEffectiveProfileQuota()
      const quota = Number(quotaRs?.quota || 0)
      const used = countWebProfiles()
      const available = Math.max(0, quota - used)
      if (incoming > available) {
        const isFree = quotaRs?.source === 'free'
        const detail = isFree
          ? `Bản miễn phí chỉ cho phép ${quota} profile (đang có ${used}). File này chứa ${incoming} profile. Kích hoạt key để tăng giới hạn hoặc xoá bớt profile cũ.`
          : `Đã đạt giới hạn gói hiện tại: tối đa ${quota} profile, đang có ${used}, file chứa thêm ${incoming}.`
        logRuntime('import-quota-blocked', {
          source: quotaRs?.source || 'unknown',
          quota,
          used,
          incoming,
        })
        return { ok: false, message: detail }
      }
    }

    const imported = []
    const restoreChecks = []
    for (const profile of manifest.profiles) {
      const sourceDir = path.join(tempRoot, ...(String(profile.relativeRoot || '').split('/').filter(Boolean)))
      const displayName = String(profile.displayName || profile.profileName || 'Imported Desktop').trim() || 'Imported Desktop'
      let newProfileName = uniqueProfileName(displayName)
      let destDir = profileDir(newProfileName)
      let copied = false

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          copyDirectoryFiltered(sourceDir, destDir)
          copied = true
          break
        } catch (error) {
          const code = String(error?.code || '').trim().toUpperCase()
          logRuntime('import-copy-retry', {
            profileName: newProfileName,
            displayName,
            attempt,
            code: code || 'unknown',
            message: error?.message || 'unknown',
          })

          if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EEXIST'].includes(code) || attempt >= 3) {
            return {
              ok: false,
              message: `Không thể nhập profile ${displayName}: ${error?.message || 'IO error'}`,
            }
          }

          await new Promise((resolve) => setTimeout(resolve, attempt * 400))
          newProfileName = uniqueProfileName(displayName)
          destDir = profileDir(newProfileName)
        }
      }

      if (!copied) {
        return { ok: false, message: `Không thể nhập profile ${displayName}: thư mục đích đang bị khóa` }
      }

      const snapshot = profile?.metaSnapshot && typeof profile.metaSnapshot === 'object' ? profile.metaSnapshot : {}
      const meta = loadProfileMeta(newProfileName) || {}
      meta.displayName = String(snapshot.displayName || displayName).trim() || displayName
      meta.profileName = newProfileName
      meta.launchMode = 'pc'
      meta.cloneId = cloneRuntime.cloneIdFor(newProfileName)
      meta.proxy = normalizeProxy(snapshot.proxy || meta.proxy || {})
      meta.fingerprint = normalizeFingerprint(snapshot.fingerprint || meta.fingerprint || {})
      meta.privacy = normalizeProfilePrivacy(snapshot.privacy || meta.privacy || {})
      meta.createdAt = snapshot.createdAt || meta.createdAt || new Date().toISOString()
      meta.importedAt = new Date().toISOString()
      meta.importSourceFormat = manifest.format
      meta.importSourceProfileName = String(profile.profileName || '').trim() || ''
      saveProfileMeta(newProfileName, meta)

      // The PC clone shim derives APPDATA paths from the profile's cloneId
      // (Roaming/__zalomask_clone_env__/<cloneId>/… and ZaloData_<cloneId>/).
      // After import, the new profile's cloneId differs from the source's,
      // so unless we rename the cloneId-bearing folders Zalo will look at
      // empty new directories and force a fresh QR login.
      const oldCloneId = String(profile.cloneId || '').trim()
      const newCloneId = String(meta.cloneId || '').trim()

      // Older ZaloMask builds (≤ 26.3.12) double-wrapped APPDATA, leaving
      // Cookies / Local State at __zalomask_clone_env__/<oldId>/__zalomask_clone_env__/<oldId>/...
      // The fixed shim wraps APPDATA once, so we MUST flatten any incoming
      // doubly-nested layout BEFORE renameCloneIdFolders runs (so the rename
      // operates on a normalised tree). This fixes "imported profile asks for
      // QR login on a different machine".
      if (oldCloneId) {
        const flattenStats = flattenDoublyNestedClone(destDir, oldCloneId)
        if (flattenStats.flattenedWrappers || flattenStats.flattenedDataDirs) {
          logRuntime('import-flatten-doubly-nested', {
            profileName: newProfileName,
            oldCloneId,
            ...flattenStats,
          })
        }
      }

      if (oldCloneId && newCloneId && oldCloneId !== newCloneId) {
        const renameStats = renameCloneIdFolders(destDir, oldCloneId, newCloneId)
        logRuntime('import-rename-clone-id', {
          profileName: newProfileName,
          oldCloneId,
          newCloneId,
          ...renameStats,
        })
      }

      try {
        const pidFile = path.join(destDir, 'pid.txt')
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
      } catch (_) {}

      // Re-DPAPI-protect the Chromium AES cookie key for this machine.
      // Without this, all v10 cookie blobs from the source machine are
      // unreadable → Zalo forces a fresh QR login after every restore.
      const cookieKeyB64 = typeof profile.cookieKeyB64 === 'string' ? profile.cookieKeyB64.trim() : ''
      let cookieKeyApplied = null // null = no key in package
      if (cookieKeyB64) {
        const roaming = path.join(destDir, 'AppData', 'Roaming')
        const lsPaths = findNamedFilesUnderDir(roaming, 'local state', 22)
        let appliedCount = 0
        for (const lsPath of lsPaths) {
          if (applyChromiumCookieKey(lsPath, cookieKeyB64)) appliedCount += 1
        }
        if (lsPaths.length === 0) {
          const legacyLs = path.join(roaming, 'ZaloData', 'Local State')
          cookieKeyApplied = applyChromiumCookieKey(legacyLs, cookieKeyB64) ? true : false
          appliedCount = cookieKeyApplied ? 1 : 0
        } else {
          cookieKeyApplied = appliedCount > 0 ? true : false
        }
        logRuntime('import-cookie-key-apply', {
          profileName: newProfileName,
          applied: cookieKeyApplied,
          localStateFiles: lsPaths.length,
          appliedCount,
        })
      } else {
        logRuntime('import-cookie-key-apply', { profileName: newProfileName, applied: null, reason: 'no-key-in-package' })
      }

      restoreChecks.push(assessImportedDesktopProfile(newProfileName, destDir, { cookieKeyApplied }))
      imported.push({ profileName: newProfileName, displayName: meta.displayName, cookieKeyApplied })
    }

    if (imported.length > 0) {
      const firstMeta = loadProfileMeta(imported[0].profileName)
      if (firstMeta?.proxy?.enabled) {
        const liveRs = checkProxyViaCurl(firstMeta.proxy, { bypassCache: false, requireZaloReachable: true })
        if (!liveRs.ok) {
          logRuntime('import-auto-launch-proxy-failed', {
            profileName: imported[0].profileName,
            reason: liveRs.message || 'proxy-unreachable',
          })
          return {
            ok: true,
            profileName: imported[0]?.profileName || '',
            displayName: imported[0]?.displayName || '',
            launchMode: 'pc',
            count: imported.length,
            imported,
            restoreChecks,
            verifyWarnings,
            cookieKeyAppliedAll: restoreChecks.length > 0
              && restoreChecks.every((c) => c.cookieKeyApplied === true || c.cookieKeyApplied === null),
            cookieKeyAppliedAny: restoreChecks.some((c) => c.cookieKeyApplied === true),
            autoLaunch: false,
            message: `Profile đã nhập nhưng chưa mở vì proxy không khả dụng: ${liveRs.message || 'proxy-unreachable'}`,
          }
        }
        logRuntime('import-auto-launch-proxy-live', {
          profileName: imported[0].profileName,
          ip: liveRs.ip || '',
          cached: !!liveRs.cached,
        })
      }
      const patchRs = await ensurePcRuntimePatchReady('import-archive')
      if (!patchRs.ok) {
        logRuntime('import-auto-launch-patch-failed', { profileName: imported[0].profileName, message: patchRs.message })
        const cookieKeyAppliedAll = restoreChecks.length > 0
          && restoreChecks.every((c) => c.cookieKeyApplied === true || c.cookieKeyApplied === null)
        const cookieKeyAppliedAny = restoreChecks.some((c) => c.cookieKeyApplied === true)
        return {
          ok: true,
          profileName: imported[0]?.profileName || '',
          displayName: imported[0]?.displayName || '',
          launchMode: 'pc',
          count: imported.length,
          imported,
          restoreChecks,
          verifyWarnings,
          cookieKeyAppliedAll,
          cookieKeyAppliedAny,
          autoLaunch: false,
          message: patchRs.message,
        }
      }
      await cloneRuntime.launchPcProfile(imported[0].profileName, {
        meta: firstMeta,
        profileDir: profileDir(imported[0].profileName),
        logger: (event, info) => logRuntime(event, info),
      })
    }

    // Roll-up health flags so callers (UI, cloud-sync) can show a single
    // "session restored / forced re-login" verdict without walking the array.
    const cookieKeyAppliedAll = restoreChecks.length > 0
      && restoreChecks.every((c) => c.cookieKeyApplied === true || c.cookieKeyApplied === null)
    const cookieKeyAppliedAny = restoreChecks.some((c) => c.cookieKeyApplied === true)

    return {
      ok: true,
      profileName: imported[0]?.profileName || '',
      displayName: imported[0]?.displayName || '',
      launchMode: 'pc',
      count: imported.length,
      imported,
      restoreChecks,
      verifyWarnings,
      cookieKeyAppliedAll,
      cookieKeyAppliedAny,
    }
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch (_) {}
  }
}

function buildDesktopProfilesPackage(profileNames) {
  const names = [...new Set((profileNames || []).map((x) => String(x || '').trim()).filter(Boolean))]
  if (names.length === 0) return { ok: false, message: 'Chưa có profile để đóng gói' }

  const tempRoot = path.join(os.tmpdir(), shortTempName('zmcp'))
  const archivePath = path.join(os.tmpdir(), shortTempName('zmcp', '.zip'))
  const profilesRoot = path.join(tempRoot, 'profiles')
  ensureDir(profilesRoot)

  try {
    const manifestProfiles = []
    for (const profileName of names) {
      const meta = loadProfileMeta(profileName)
      if (!meta) continue
      const srcDir = profileDir(profileName)
      if (!fs.existsSync(srcDir)) continue
      const stagedDir = path.join(profilesRoot, profileName)
      copyDirectoryFiltered(srcDir, stagedDir)
      manifestProfiles.push(buildDesktopPackageManifestEntry(profileName, stagedDir, meta, {
        mode: 'portable',
        sourceProfileDir: srcDir,
      }))
    }

    if (manifestProfiles.length === 0) return { ok: false, message: 'Không có profile hợp lệ để sao lưu' }

    const manifest = withChecksum({
      format: PORTABLE_PACKAGE_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      backupEngine: 'portable-snapshot',
      count: manifestProfiles.length,
      profiles: manifestProfiles,
    })
    writeJson(path.join(tempRoot, 'manifest.json'), manifest)

    compressDirectoryToArchive(tempRoot, archivePath)
    const buffer = fs.readFileSync(archivePath)
    const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    return {
      ok: true,
      buffer,
      checksumSha256,
      count: manifestProfiles.length,
      profileNames: manifestProfiles.map((x) => x.profileName),
    }
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch (_) {}
    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath) } catch (_) {}
  }
}

async function importDesktopProfilesBuffer(buffer, sourceName = 'cloud-backup.zmb', opts = {}) {
  const sourceExt = String(path.extname(sourceName || '') || '.zmb').toLowerCase()
  const tempArchive = path.join(os.tmpdir(), shortTempName('zmci', sourceExt))
  try {
    fs.writeFileSync(tempArchive, buffer)
    return importDesktopProfilesArchive(tempArchive, opts)
  } finally {
    try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive) } catch (_) {}
  }
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
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    let rs
    try {
      rs = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      })
    } catch (fetchErr) {
      if (fetchErr?.name === 'AbortError') {
        return { ok: false, status: 0, body: { ok: false, message: 'Hết thời gian chờ kết nối.' } }
      }
      return { ok: false, status: 0, body: { ok: false, message: fetchErr?.message || 'Lỗi mạng' } }
    }
    const contentType = String(rs.headers.get('content-type') || '').toLowerCase()
    const text = await rs.text()
    let body = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        const looksHtml =
          contentType.includes('text/html')
          || /^[\s\n]*<!DOCTYPE/i.test(text)
          || /<html[\s>]/i.test(text.slice(0, 800))
        let message
        if (looksHtml && rs.status === 404) {
          message =
            'Không tìm thấy API trên máy chủ (404). Hãy deploy web có routes đồng bộ mới (/api/cloud-sync/upload-init, upload-commit) hoặc kiểm tra licenseApiBaseUrl trong config.'
        } else if (looksHtml) {
          message = `Máy chủ trả trang HTML (HTTP ${rs.status}) thay vì JSON — kiểm tra địa chỉ API hoặc proxy/CDN.`
        } else {
          const clip = text.replace(/\s+/g, ' ').slice(0, 240)
          message = clip ? `Phản hồi không phải JSON (${clip})` : `HTTP ${rs.status}`
        }
        body = { ok: false, message }
      }
    }
    if (!rs.ok && typeof body.message !== 'string') {
      body = { ...body, ok: body.ok ?? false, message: body.message || `HTTP ${rs.status}` }
    }
    return { ok: rs.ok, status: rs.status, body }
  } finally {
    clearTimeout(t)
  }
}

async function getJson(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let rs
    try {
      rs = await fetch(url, { method: 'GET', headers: { ...(opts.headers || {}) }, signal: controller.signal })
    } catch (fetchErr) {
      if (fetchErr?.name === 'AbortError') {
        return { ok: false, status: 0, body: { ok: false, message: 'Hết thời gian chờ kết nối.' } }
      }
      return { ok: false, status: 0, body: { ok: false, message: fetchErr?.message || 'Lỗi mạng' } }
    }
    const contentType = String(rs.headers.get('content-type') || '').toLowerCase()
    const text = await rs.text()
    let body = {}
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        const looksHtml =
          contentType.includes('text/html')
          || /^[\s\n]*<!DOCTYPE/i.test(text)
          || /<html[\s>]/i.test(text.slice(0, 800))
        let message
        if (looksHtml && rs.status === 404) {
          message =
            'Không tìm thấy API trên máy chủ (404). Deploy web có route /api/cloud-sync/download hoặc kiểm tra licenseApiBaseUrl.'
        } else if (looksHtml) {
          message = `Máy chủ trả trang HTML (HTTP ${rs.status}) thay vì JSON.`
        } else {
          const clip = text.replace(/\s+/g, ' ').slice(0, 240)
          message = clip ? `Phản hồi không phải JSON (${clip})` : `HTTP ${rs.status}`
        }
        body = { ok: false, message }
      }
    }
    if (!rs.ok && typeof body.message !== 'string') {
      body = { ...body, ok: body.ok ?? false, message: body.message || `HTTP ${rs.status}` }
    }
    return { ok: rs.ok, status: rs.status, body }
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
      try {
        await wipeAllLocalProfiles()
      } catch (err) {
        logRuntime('cloud-auto-wipe-error', { message: err?.message })
      }
    }

    try {
      mainWindow?.webContents.send('license-kicked', { status, message, state })
    } catch (_) {}

    setTimeout(() => {
      logRuntime('license-kick-ui-settled', { status })
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

function profileDeleteMarkerPath(profileName) {
  return path.join(profileDir(profileName), '.delete-pending')
}

function isProfileDeleting(profileName, meta = null) {
  const key = String(profileName || '').trim()
  if (!key) return false
  if (deletingProfiles.has(key)) return true
  if (meta && meta.deleting) return true
  try {
    return fs.existsSync(profileDeleteMarkerPath(key))
  } catch (_) {
    return false
  }
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
  while (
    fs.existsSync(profileMetaPath(name))
    || fs.existsSync(profileDir(name))
    || isProfileDeleting(name)
  ) {
    i += 1
    name = `${root}_${i}`
  }
  return name
}

function normalizeLaunchMode(mode) {
  const key = String(mode || '').toLowerCase()
  if (key === 'pc') return 'pc'
  // PC-only runtime: migrate legacy web/web2 profiles to PC mode on access.
  return 'pc'
}

function listAllProfiles() {
  ensureDir(PROFILES_DIR)
  const names = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const items = []

  for (const name of names) {
    const meta = safeReadJson(profileMetaPath(name), null)
    if (!meta) continue
    if (isProfileDeleting(name, meta)) continue

    // Legacy clone profiles (v1, 'clone' mode) are hidden in v2 runtime.
    if (meta.launchMode && meta.launchMode !== 'web' && meta.launchMode !== 'web2' && meta.launchMode !== 'pc') continue

    const launchMode = normalizeLaunchMode(meta.launchMode)
    if (meta.launchMode !== launchMode) {
      meta.launchMode = launchMode
      if (!meta.cloneId) meta.cloneId = cloneRuntime.cloneIdFor(name)
      saveProfileMeta(name, meta)
    }

    const webSession = meta.webSession || {}
    items.push({
      profileName: name,
      displayName: meta.displayName || name,
      launchMode,
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

function redactDiagnosticsText(text) {
  let s = String(text || '')
  s = s.replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"')
  s = s.replace(/"password"\s*:\s*'[^']*'/gi, `"password":'***'`)
  s = s.replace(/"token"\s*:\s*"[^"]{8,}"/gi, '"token":"***"')
  s = s.replace(/Proxy-Authorization:\s*[^\s\r\n]+/gi, 'Proxy-Authorization: ***')
  return s
}

function buildLogHighlightFromText(text) {
  const lines = String(text || '').split('\n')
  const pat =
    /uncaught|unhandled|failed|thất bại|asar-patch|copy-failed|EBUSY|ENOTDIR|render-process-gone|child-process-gone|kick|quota|error:|exception|Không [a-zA-Zà-ỹ]* được|Lỗi|timeout|refused|ECONN|renderer-client-log|EPIPE|crash/i
  const out = []
  for (const line of lines) {
    if (pat.test(line)) out.push(line)
  }
  return out.slice(-500).join('\n')
}

function redactDiagnosticsDetailObject(obj, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (obj == null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((x) => redactDiagnosticsDetailObject(x, depth + 1))
  const o = {}
  for (const [k, v] of Object.entries(obj)) {
    const lk = String(k).toLowerCase()
    if ((lk.includes('password') || lk === 'token' || lk.includes('secret')) && typeof v === 'string') {
      o[k] = '***'
    } else if (v && typeof v === 'object') {
      o[k] = redactDiagnosticsDetailObject(v, depth + 1)
    } else {
      o[k] = v
    }
  }
  return o
}

function profileSummaryForDiagnostics() {
  try {
    return listAllProfiles().map((p) => ({
      profileName: p.profileName,
      displayName: p.displayName,
      launchMode: p.launchMode,
      cookieCount: p.cookieCount,
      localStorageCount: p.localStorageCount,
      proxyEnabled: !!(p.proxy && p.proxy.enabled),
      proxyProtocol: p.proxy && p.proxy.enabled ? String(p.proxy.protocol || '') : '',
    }))
  } catch (e) {
    return { error: e.message || String(e) }
  }
}

function licenseSummaryForDiagnostics() {
  try {
    const st = getLicenseRuntimeStatus()
    const state = st.state && typeof st.state === 'object' ? { ...st.state } : {}
    if (state.token) state.token = '***'
    if (typeof state.key === 'string' && state.key.length > 0) {
      state.key = state.key.length > 10 ? `${state.key.slice(0, 4)}…${state.key.slice(-4)}` : '***'
    }
    return { ...st, state }
  } catch (e) {
    return { error: e.message || String(e) }
  }
}

function zipStagingDirToFile(sourceDir, outZipPath) {
  const absZip = path.resolve(outZipPath)
  const absSrc = path.resolve(sourceDir)
  try {
    fs.unlinkSync(absZip)
  } catch (_) {}
  const t = spawnSync('tar', ['-a', '-c', '-f', absZip, '-C', absSrc, '.'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (t.status === 0 && fs.existsSync(absZip)) return true
  const esc = (p) => String(p).replace(/'/g, "''")
  const cmd = [
    `$ErrorActionPreference='Stop'`,
    `$out='${esc(absZip)}'`,
    `$src='${esc(absSrc)}'`,
    `if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }`,
    `Compress-Archive -Path (Join-Path $src '*') -DestinationPath $out -CompressionLevel Fastest -Force`,
  ].join('; ')
  const p = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 50 * 1024 * 1024,
  })
  return p.status === 0 && fs.existsSync(absZip)
}

async function exportDiagnosticsToZipFile(outZipPath) {
  const fsp = fs.promises
  ensureDir(path.dirname(path.resolve(outZipPath)))
  const staging = path.join(os.tmpdir(), `zalomask-diagnostics-${Date.now()}`)
  await fsp.mkdir(staging, { recursive: true })
  const readme = [
    'ZaloMask — gói chẩn đoán (diagnostics bundle)',
    '',
    'Đính kèm file ZIP này khi báo lỗi (chat / email / ticket).',
    'Không thể ghi mọi sự cố tự động (silence UI, lỗi trong process ngoài Electron), nhưng gói này gom:',
    '  • manifest + runtime PC + tóm tắt profile/license',
    '  • app-runtime.tail.log (đuôi file log chính, đã redact)',
    '  • app-log-errors-highlight.txt (lọc dòng có khóa lỗi từ cùng đoạn tail)',
    '  • Main process: uncaughtException, unhandledRejection, render/child-process-gone (vào tail log)',
    '  • Renderer: lỗi JS + promise reject (forward vào main → tail log)',
    'Log đã redact một phần (password/token); vẫn không công khai nếu lo ngại.',
    '',
    `host: ${os.hostname()}`,
    `exportedAt: ${new Date().toISOString()}`,
  ].join('\r\n')
  await fsp.writeFile(path.join(staging, 'README-diagnostics.txt'), readme, 'utf8')

  const manifest = {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    isPackaged: IS_PACKAGED,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    hostname: os.hostname(),
    userData: app.getPath('userData'),
    exePath: app.getPath('exe'),
    resourcesPath: process.resourcesPath || '',
    rootDir: ROOT_DIR,
    runtimeLogPath: RUNTIME_LOG,
    profilesDir: PROFILES_DIR,
    argv: process.argv,
  }
  await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const runtime = await cloneRuntime.getRuntimeStatus()
  await fsp.writeFile(path.join(staging, 'runtime-status.json'), JSON.stringify(runtime, null, 2), 'utf8')
  await fsp.writeFile(path.join(staging, 'profiles-summary.json'), JSON.stringify(profileSummaryForDiagnostics(), null, 2), 'utf8')
  await fsp.writeFile(path.join(staging, 'license-summary.json'), JSON.stringify(licenseSummaryForDiagnostics(), null, 2), 'utf8')

  let logContent = ''
  let rawLogSlice = ''
  try {
    if (fs.existsSync(RUNTIME_LOG)) {
      const raw = fs.readFileSync(RUNTIME_LOG, 'utf8')
      const max = 900000
      rawLogSlice = raw.length > max ? raw.slice(-max) : raw
      logContent = redactDiagnosticsText(rawLogSlice)
    } else {
      logContent = '(no log file)\npath: ' + RUNTIME_LOG
    }
  } catch (e) {
    logContent = '(read failed) ' + (e.message || String(e))
  }
  await fsp.writeFile(path.join(staging, 'app-runtime.tail.log'), logContent, 'utf8')
  const highlightBody = buildLogHighlightFromText(rawLogSlice)
  await fsp.writeFile(
    path.join(staging, 'app-log-errors-highlight.txt'),
    redactDiagnosticsText(
      highlightBody || '(không có dòng khớp từ khoá lỗi — xem app-runtime.tail.log)',
    ),
    'utf8',
  )

  if (!zipStagingDirToFile(staging, outZipPath)) {
    try {
      await fsp.rm(staging, { recursive: true, force: true })
    } catch (_) {}
    throw new Error('Không tạo được file ZIP (tar / PowerShell Compress-Archive).')
  }
  try {
    await fsp.rm(staging, { recursive: true, force: true })
  } catch (_) {}
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

function validatePcRuntimeProxy(proxy) {
  const p = normalizeProxy(proxy)
  if (!p.enabled) return { ok: true, proxy: p }
  if (p.authEnabled && p.protocol === 'SOCKS5') {
    return {
      ok: false,
      message: 'Zalo PC hiện mới hỗ trợ proxy auth qua local bridge cho HTTP proxy. SOCKS5 auth chưa được hỗ trợ.',
      proxy: p,
    }
  }
  return { ok: true, proxy: p }
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

function checkProxyViaCurl(proxy, options = {}) {
  const p = normalizeProxy(proxy)
  if (!p.enabled) return { ok: false, message: 'Proxy chưa đủ thông tin host/port' }
  const bypassCache = !!options?.bypassCache
  const requireZaloReachable = !!options?.requireZaloReachable

  const cacheKey = [p.protocol, p.host, p.port, p.authEnabled ? p.username : '', p.authEnabled ? p.password : ''].join('|')
  const cached = bypassCache ? null : proxyCheckCache.get(cacheKey)
  if (cached && cached.ok && (Date.now() - cached.at) < 120000 && (!requireZaloReachable || cached.zaloOk)) {
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
          let zaloOk = false
          if (requireZaloReachable) {
            const argsZalo = [
              '-sS',
              '--max-time', '10',
              '--connect-timeout', '5',
              '--proxy', proxyUrl,
              '-o', 'NUL',
              '-w', '%{http_code}',
              'https://chat.zalo.me/',
            ]
            if (p.authEnabled && p.username) {
              argsZalo.splice(argsZalo.length - 1, 0, '--proxy-user', `${p.username}:${p.password || ''}`)
            }
            const rsZalo = spawnSync('curl.exe', argsZalo, { encoding: 'utf8', windowsHide: true, timeout: 12000 })
            const statusZalo = typeof rsZalo.status === 'number' ? rsZalo.status : 1
            const codeText = String(rsZalo.stdout || '').trim()
            const code = Number.parseInt(codeText, 10)
            if (statusZalo !== 0 || !Number.isFinite(code) || code <= 0 || code >= 500) {
              const errText = String(rsZalo.stderr || rsZalo.stdout || '').trim()
              return {
                ok: false,
                message: errText
                  ? `Proxy live nhưng không tới được chat.zalo.me: ${humanizeProxyError(errText)}`
                  : 'Proxy live nhưng không tới được chat.zalo.me',
              }
            }
            zaloOk = true
          }

          proxyCheckCache.set(cacheKey, { ok: true, ip: json.ip, at: Date.now(), zaloOk })
          return { ok: true, ip: json.ip, zaloOk }
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

let mainWindow = null
/** Tránh spam nudge khi restore liên tục */
let mainWindowCompositeNudgeTimer = null

/**
 * Windows DWM / Chromium thỉnh thoảng không composite lại (UI trông "đơ").
 * MỤC TIÊU: invalidate + repaint nhẹ — KHÔNG dùng setBounds ping-pong trong nhánh mặc định;
 * trick resize chỉ chạy khi unwrap từ taskbar (restore) vì gọi khi đang gõ trong modal gây đơ.
 */
function nudgeMainWindowComposite(options = {}) {
  const resizeHack = !!options.resizeHack
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (mainWindowCompositeNudgeTimer) return
  mainWindowCompositeNudgeTimer = setTimeout(() => {
    mainWindowCompositeNudgeTimer = null
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const w = mainWindow
      const wc = w.webContents
      try {
        if (typeof wc.invalidate === 'function') wc.invalidate()
      } catch (_) {}
      if (resizeHack) {
        try {
          const b = w.getBounds()
          w.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height })
          w.setBounds(b)
        } catch (_) {}
      }
    } catch (_) {}
  }, 32)
}

function sanitizeWindowsFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'Profile'
}

function buildShortcutArguments(profileName) {
  const openArg = `--zalomask-open-profile=${profileName}`
  if (app.isPackaged) return openArg
  return `"${path.resolve(__dirname)}" ${openArg}`
}

function createWindowsShortcut(shortcutPath, targetPath, argumentsValue, workingDirectory, iconPath) {
  runPowerShellCommand(
    "$lnkPath=$args[0]; $target=$args[1]; $argsText=$args[2]; $workDir=$args[3]; $icon=$args[4]; $ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut($lnkPath); $lnk.TargetPath=$target; $lnk.Arguments=$argsText; if($workDir){$lnk.WorkingDirectory=$workDir}; if($icon){$lnk.IconLocation=$icon}; $lnk.Save()",
    [shortcutPath, targetPath, argumentsValue || '', workingDirectory || '', iconPath || ''],
  )
}

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
      spellcheck: false,
      backgroundThrottling: false,
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
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    if (code === -3 || code === 0) return
    logRuntime('main-window-did-fail-load', {
      code,
      desc: String(desc || '').slice(0, 800),
      url: String(url || '').slice(0, 2000),
    })
  })

  mainWindow.on('restore', () => nudgeMainWindowComposite({ resizeHack: true }))
}

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
      launchMode: normalizeLaunchMode(meta.launchMode),
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
  const patchRs = await ensurePcRuntimePatchReady('launch-all')
  if (!patchRs.ok) {
    return {
      ok: false,
      count: profiles.length,
      message: patchRs.message,
    }
  }
  const errors = []
  for (const profile of profiles) {
    try {
      const meta = loadProfileMeta(profile.profileName)
      const rs = await cloneRuntime.launchPcProfile(profile.profileName, {
        meta,
        profileDir: profileDir(profile.profileName),
        logger: (event, info) => logRuntime(event, info),
      })
      if (!rs.ok) throw new Error(rs.message || 'Không mở được Zalo PC')
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

ipcMain.handle('client-log', async (_event, payload) => {
  const level = String(payload?.level || 'info').slice(0, 24)
  const message = String(payload?.message || '').slice(0, 4000)
  let detail = payload?.detail
  try {
    if (detail && typeof detail === 'object') {
      detail = redactDiagnosticsDetailObject(detail)
    }
  } catch (_) {
    detail = '[detail redact failed]'
  }
  logRuntime('renderer-client-log', { level, message, detail })
  return { ok: true }
})

ipcMain.handle('nudge-composite', async () => {
  nudgeMainWindowComposite()
  return { ok: true }
})

ipcMain.handle('export-diagnostics', async () => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const defaultPath = path.join(app.getPath('desktop'), `ZaloMask-diagnostics-${stamp}.zip`)
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Lưu báo cáo chẩn đoán',
    defaultPath,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  try {
    await exportDiagnosticsToZipFile(filePath)
    logRuntime('diagnostics-export-ui-ok', { path: filePath })
    return { ok: true, path: filePath }
  } catch (e) {
    const msg = e?.message || String(e)
    logRuntime('diagnostics-export-ui-failed', { message: msg })
    return { ok: false, message: msg }
  }
})

ipcMain.handle('get-system-health', async () => {
  const profiles = listAllProfiles()
  const runtime = await cloneRuntime.getRuntimeStatus()
  const info = {
    profileCount: profiles.length,
    webCount: 0,
    cloneCount: profiles.length,
    desktopCount: profiles.length,
    appVersion: APP_VERSION,
    runtime,
  }
  const warnings = []
  if (profiles.length === 0) warnings.push('Chưa có profile nào')
  if (!runtime.ok) warnings.push(runtime.message || 'Runtime chưa sẵn sàng')
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

    const runtime = await cloneRuntime.getRuntimeStatus()
    if (!runtime.ok) {
      return { ok: false, message: runtime.message || 'Runtime Zalo PC chưa sẵn sàng.' }
    }

    const displayName = String(payload?.displayName || '').trim() || 'Zalo PC'
    const profileName = uniqueProfileName(displayName)
    const licenseId = crypto.randomUUID()
    const launchMode = 'pc'
    const proxyCheck = validatePcRuntimeProxy(payload?.proxy || {})
    if (!proxyCheck.ok) {
      return { ok: false, message: proxyCheck.message }
    }

    const meta = {
      displayName,
      profileName,
      launchMode,
      license_id: licenseId,
      createdAt: new Date().toISOString(),
      proxy: proxyCheck.proxy,
      fingerprint: generateFingerprint(),
      privacy: { hideTyping: false, hideSeen: false, hideReceived: false },
    }
    // PC mode profile dir is created lazily on first launch by clone-main-shim
    // (junctions APPDATA per cloneId). cloneId stored on meta for stable id.
    meta.cloneId = cloneRuntime.cloneIdFor(profileName)

    saveProfileMeta(profileName, meta)

    const patchRs = await ensurePcRuntimePatchReady('add-profile')
    if (!patchRs.ok) {
      return { ok: false, message: patchRs.message, profileCreated: true, profileName }
    }

    // PC mode: launch Zalo.exe immediately with the new clone id.
    const rs = await cloneRuntime.launchPcProfile(profileName, {
      meta,
      profileDir: profileDir(profileName),
      logger: (event, info) => logRuntime(event, info),
    })
    if (!rs.ok) return { ok: false, message: rs.message, profileCreated: true, profileName }

    return { ok: true, profileName, displayName, launchMode, license_id: licenseId }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không tạo được profile' }
  }
})

ipcMain.handle('open-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  if (isProfileDeleting(profileName)) {
    return { ok: false, message: 'Profile đang được xóa. Vui lòng đợi vài giây.' }
  }
  try {
    // -- Issue #3: license-bound profile validation ---------------------
    // Profile mới sinh sau khi multi-key landing có gắn license_id. Nếu
    // license đó bị revoked/expired thì chặn mở. Profile legacy (không có
    // license_id) vẫn cho mở để backward compat.
    const meta = loadProfileMeta(profileName)
    if (!meta) return { ok: false, message: 'Không tìm thấy profile' }
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

    // PC-only runtime: legacy modes are migrated and launched as PC.
    meta.launchMode = normalizeLaunchMode(meta.launchMode)
    if (!meta.cloneId) {
      meta.cloneId = cloneRuntime.cloneIdFor(profileName)
      saveProfileMeta(profileName, meta)
    }

    // Patch bundle BEFORE proxy checks / launch so clone shim + APPDATA isolation apply.
    const patchRs = await ensurePcRuntimePatchReady('open-profile')
    if (!patchRs.ok) return patchRs

    // Fast path: if this profile is already running, skip proxy live-check and
    // delegate to launchPcProfile() to focus the existing window.
    const runtimeState = await cloneRuntime.getPcProfileRuntimeState(profileName, {
      profileDir: profileDir(profileName),
    })
    if (runtimeState?.ok && runtimeState.running) {
      const runningRs = await cloneRuntime.launchPcProfile(profileName, {
        meta,
        profileDir: profileDir(profileName),
        logger: (event, info) => logRuntime(event, info),
      })
      if (!runningRs.ok) return runningRs
      return { ok: true, mode: 'pc', cloneId: runningRs.cloneId, pid: runningRs.pid, alreadyRunning: true }
    }

    const proxyCheck = validatePcRuntimeProxy(meta.proxy || {})
    if (!proxyCheck.ok) return { ok: false, message: proxyCheck.message }
    meta.proxy = proxyCheck.proxy

    // Soft proxy live-check: ngày trước nếu curl tới api.ipify/chat.zalo.me
    // fail → block luôn lệnh mở. Thực tế nhiều mạng noisy hoặc proxy gateway
    // chỉ chặn ipify nhưng vẫn cho Zalo, hoặc curl bị firewall đặc biệt — sẽ
    // chặn nhầm. Bây giờ: live-check fail → HỎI user qua dialog 3 lựa chọn:
    //   1. "Vẫn mở (giữ proxy)"      → launch with proxy, kệ live-check
    //   2. "Mở không qua proxy"      → tạm vô hiệu proxy cho lần này
    //   3. "Huỷ"                     → return error
    // Nếu user chọn (2), KHÔNG ghi đè meta.proxy trên disk — chỉ override
    // local copy `meta.proxy.enabled = false` cho launchPcProfile lần này.
    let proxyOverrideForLaunch = null
    if (meta.proxy?.enabled) {
      const liveRs = checkProxyViaCurl(meta.proxy, { bypassCache: false, requireZaloReachable: true })
      if (!liveRs.ok) {
        const reason = liveRs.message || 'proxy-unreachable'
        logRuntime('open-profile-proxy-failed', { profileName, reason })

        let choice = 1 // default: cancel, in case dialog fails to spawn
        try {
          const focusWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
          const opts = {
            type: 'warning',
            buttons: [
              'Vẫn mở (giữ proxy)',
              'Mở không qua proxy',
              'Huỷ',
            ],
            defaultId: 0,
            cancelId: 2,
            title: 'Proxy không khả dụng',
            message: `Proxy đang bật nhưng kiểm tra fail: ${reason}`,
            detail:
              'Bạn có thể vẫn mở Zalo bằng proxy này (Zalo có thể tự retry / proxy chỉ chặn ipify), ' +
              'hoặc tạm thời mở mà không qua proxy. Lựa chọn không qua proxy chỉ áp dụng cho lần mở này, ' +
              'không ghi đè cấu hình profile.',
            noLink: true,
          }
          choice = focusWin
            ? dialog.showMessageBoxSync(focusWin, opts)
            : dialog.showMessageBoxSync(opts)
        } catch (dialogError) {
          logRuntime('open-profile-proxy-dialog-failed', {
            profileName,
            message: dialogError?.message || String(dialogError),
          })
        }

        if (choice === 2) {
          return { ok: false, message: `Đã huỷ mở profile (proxy không khả dụng: ${reason})` }
        }
        if (choice === 1) {
          proxyOverrideForLaunch = { ...meta.proxy, enabled: false }
          logRuntime('open-profile-proxy-bypassed-by-user', { profileName, reason })
        } else {
          // choice === 0 hoặc bất kỳ giá trị bất ngờ nào khác → giữ proxy như cũ.
          logRuntime('open-profile-proxy-forced-launch', { profileName, reason })
        }
      } else {
        logRuntime('open-profile-proxy-live', {
          profileName,
          ip: liveRs.ip || '',
          cached: !!liveRs.cached,
        })
      }
    }

    const launchMeta = proxyOverrideForLaunch
      ? { ...meta, proxy: proxyOverrideForLaunch }
      : meta
    const rs = await cloneRuntime.launchPcProfile(profileName, {
      meta: launchMeta,
      profileDir: profileDir(profileName),
      logger: (event, info) => logRuntime(event, info),
    })
    if (!rs.ok) return rs
    return {
      ok: true,
      mode: 'pc',
      cloneId: rs.cloneId,
      pid: rs.pid,
      proxyBypassed: !!proxyOverrideForLaunch,
      proxyFallback: rs.proxyFallback || null,
    }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không mở được profile' }
  }
})

ipcMain.handle('clone-runtime-status', async () => {
  try {
    const status = await cloneRuntime.getRuntimeStatus()
    return { ok: true, status }
  } catch (e) {
    return { ok: false, message: e?.message || 'unknown' }
  }
})

ipcMain.handle('update-proxy', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }

  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }

  const proxyCheck = validatePcRuntimeProxy(payload?.proxy || {})
  if (!proxyCheck.ok) return { ok: false, message: proxyCheck.message }
  meta.proxy = proxyCheck.proxy
  saveProfileMeta(profileName, meta)
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

  // Write per-profile privacy file so running Zalo process picks it up immediately (1s TTL cache in shim).
  let applied = false
  try {
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    const privDir = path.join(programData, 'ZaloMask', 'privacy')
    ensureDir(privDir)
    fs.writeFileSync(
      path.join(privDir, profileName + '.json'),
      JSON.stringify(meta.privacy),
      'utf8'
    )
    applied = true
  } catch (_) {}

  return { ok: true, privacy: meta.privacy, applied }
})

ipcMain.handle('check-proxy', async (_event, payload) => {
  return checkProxyViaCurl(payload?.proxy || payload || {})
})

async function deleteProfileLocal(profileName) {
  if (!profileName) return
  const dir = profileDir(profileName)
  if (!fs.existsSync(dir)) return

  deletingProfiles.add(profileName)

  const meta = loadProfileMeta(profileName)
  if (meta && !meta.deleting) {
    meta.deleting = true
    meta.deletingAt = new Date().toISOString()
    saveProfileMeta(profileName, meta)
  }
  try {
    fs.writeFileSync(profileDeleteMarkerPath(profileName), String(Date.now()), 'ascii')
  } catch (_) {}

  ;(async () => {
    try {
      try {
        const killRs = await cloneRuntime.terminatePcProfile(profileName, {
          profileDir: profileDir(profileName),
          logger: (event, info) => logRuntime(event, info),
        })
        logRuntime('pc-profile-terminate-before-delete', { profileName, ...killRs })
      } catch (err) {
        logRuntime('pc-profile-terminate-before-delete-error', { profileName, message: err?.message || 'unknown' })
      }

      let lastError = null
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
          logRuntime('delete-profile-cleanup-success', { profileName, attempt })
          return
        } catch (error) {
          lastError = error
          logRuntime('delete-profile-rm-retry', {
            profileName,
            attempt,
            code: error?.code || 'unknown',
            message: error?.message || 'unknown',
          })

          if (attempt === 1 || attempt === 3) {
            try {
              const killRs = await cloneRuntime.terminatePcProfile(profileName, {
                profileDir: profileDir(profileName),
                logger: (event, info) => logRuntime(event, info),
              })
              logRuntime('pc-profile-terminate-retry-before-delete', { profileName, attempt, ...killRs })
            } catch (err) {
              logRuntime('pc-profile-terminate-retry-before-delete-error', {
                profileName,
                attempt,
                message: err?.message || 'unknown',
              })
            }
          }

          await new Promise((resolve) => setTimeout(resolve, Math.min(2000, attempt * 400)))
        }
      }

      logRuntime('delete-profile-cleanup-failed', {
        profileName,
        code: lastError?.code || 'unknown',
        message: lastError?.message || 'unknown',
      })
    } finally {
      deletingProfiles.delete(profileName)
    }
  })().catch((error) => {
    deletingProfiles.delete(profileName)
    logRuntime('delete-profile-background-error', {
      profileName,
      message: error?.message || 'unknown',
    })
  })
}

ipcMain.handle('delete-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }

  if (isProfileDeleting(profileName)) {
    return { ok: true, pending: true, message: 'Profile đang trong quá trình xóa nền' }
  }

  try {
    await deleteProfileLocal(profileName)
    return { ok: true, pending: true }
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase()
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
    return {
      ok: false,
      message: locked
        ? 'Không xóa được profile vì file đang bị khóa. Hãy đóng cửa sổ Zalo của profile này rồi thử lại.'
        : (error?.message || 'Không xóa được profile'),
    }
  }
})

ipcMain.handle('rename-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  const displayName = String(payload?.displayName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  if (!displayName) return { ok: false, message: 'Tên hiển thị không được để trống' }
  if (displayName.length > 120) return { ok: false, message: 'Tên hiển thị tối đa 120 ký tự' }

  const meta = loadProfileMeta(profileName)
  if (!meta) return { ok: false, message: 'Không tìm thấy profile' }
  if (isProfileDeleting(profileName, meta)) return { ok: false, message: 'Profile đang được xóa' }

  meta.displayName = displayName
  saveProfileMeta(profileName, meta)
  logRuntime('profile-rename-display', { profileName, displayName })
  mainWindow?.webContents.send('profile-updated', profileName)
  return { ok: true, profileName, displayName }
})

ipcMain.handle('export-profile', async (_event, payload) => {
  const profileName = String(payload?.profileName || '').trim()
  if (!profileName) return { ok: false, message: 'Thiếu profileName' }
  if (!loadProfileMeta(profileName)) return { ok: false, message: 'Không tìm thấy profile' }
  return exportDesktopProfilesArchive([profileName], {
    suggestedName: `ZaloMask_${profileName}_${new Date().toISOString().slice(0, 10)}.zmb`,
    dialogTitle: 'Xuất profile desktop',
  })
})

ipcMain.handle('export-profiles', async (_event, payload) => {
  const inputNames = Array.isArray(payload?.profileNames) ? payload.profileNames : []
  const profileNames = [...new Set(inputNames.map((x) => String(x || '').trim()).filter(Boolean))]
  return exportDesktopProfilesArchive(profileNames, {
    dialogTitle: 'Sao lưu nhiều profile desktop',
  })
})

ipcMain.handle('import-profile', async () => {
  try {
    const rs = await dialog.showOpenDialog({
      title: 'Nhập profile/package',
      filters: [
        { name: 'Zalo Portable Backup', extensions: ['zmb', 'zlp', 'zip'] },
        { name: 'JSON (legacy)', extensions: ['json'] },
      ],
      properties: ['openFile'],
    })

    if (!rs || rs.canceled || !rs.filePaths || rs.filePaths.length === 0) {
      return { ok: false, message: 'Đã huỷ' }
    }

    const selectedPath = rs.filePaths[0]
    const ext = path.extname(selectedPath).toLowerCase()

    if (ext === '.zmb' || ext === '.zlp' || ext === '.zip') {
      return await importDesktopProfilesArchive(selectedPath)
    }

    // Legacy JSON import fallback.
    let raw
    try {
      raw = safeReadJson(selectedPath, null)
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

    {
      const incoming = normalizedList.length
      const quotaRs = getEffectiveProfileQuota()
      const quota = Number(quotaRs?.quota || 0)
      const used = countWebProfiles()
      const available = Math.max(0, quota - used)
      if (incoming > available) {
        const isFree = quotaRs?.source === 'free'
        const msg = isFree
          ? `Bản miễn phí chỉ cho phép ${quota} profile (đang có ${used}). File này chứa ${incoming} profile. Kích hoạt key để tăng giới hạn hoặc xoá bớt profile cũ.`
          : `Đã đạt giới hạn gói hiện tại: tối đa ${quota} profile, đang có ${used}, file chứa thêm ${incoming}.`
        logRuntime('import-quota-blocked', {
          flow: 'legacy-json',
          source: quotaRs?.source || 'unknown',
          quota,
          used,
          incoming,
        })
        return { ok: false, message: msg }
      }
    }

    const imported = []
    for (const normalized of normalizedList) {
      const profileName = uniqueProfileName(normalized.displayName)
      const meta = {
        displayName: normalized.displayName,
        profileName,
        launchMode: 'pc',
        cloneId: cloneRuntime.cloneIdFor(profileName),
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
      const firstMeta = loadProfileMeta(imported[0].profileName)
      const patchRs = await ensurePcRuntimePatchReady('import-json-legacy')
      if (!patchRs.ok) {
        logRuntime('import-json-auto-launch-patch-failed', { profileName: imported[0].profileName, message: patchRs.message })
        return {
          ok: true,
          profileName: imported[0]?.profileName || '',
          displayName: imported[0]?.displayName || '',
          launchMode: 'pc',
          count: imported.length,
          imported,
          autoLaunch: false,
          message: patchRs.message,
        }
      }
      await cloneRuntime.launchPcProfile(imported[0].profileName, {
        meta: firstMeta,
        profileDir: profileDir(imported[0].profileName),
        logger: (event, info) => logRuntime(event, info),
      })
    }

    return {
      ok: true,
      profileName: imported[0]?.profileName || '',
      displayName: imported[0]?.displayName || '',
      launchMode: 'pc',
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
  const pack = buildDesktopProfilesPackage(names)
  if (!pack.ok) return pack

  const byteLength = pack.buffer.length
  const fileName = `ZaloMask_cloud_${new Date().toISOString().slice(0, 10)}.zmb`

  try {
    const initRs = await postJson(
      `${baseUrl}/api/cloud-sync/upload-init`,
      {
        sessionId: state.sessionId,
        checksumSha256: pack.checksumSha256,
        profileCount: pack.count,
        byteLength,
        fileName,
        format: PORTABLE_PACKAGE_FORMAT,
        version: 2,
      },
      { headers, timeoutMs: 90000 },
    )
    const initOk = !!initRs.ok && initRs.body?.ok === true
    if (!initOk) {
      let message = typeof initRs.body?.message === 'string' ? initRs.body.message : ''
      if (!message) message = initRs.ok ? 'Không khởi tạo được upload cloud' : `HTTP ${initRs.status}`
      return { ok: false, message }
    }

    const signedUrl = String(initRs.body.signedUrl || '').trim()
    const objectPath = String(initRs.body.objectPath || '').trim()
    if (!signedUrl || !objectPath) return { ok: false, message: 'Thiếu signedUrl/objectPath từ máy chủ' }

    const putCtrl = new AbortController()
    const putTimer = setTimeout(() => putCtrl.abort(), 600000)
    let putStatus = 0
    try {
      const putRs = await fetch(signedUrl, {
        method: 'PUT',
        body: pack.buffer,
        headers: {
          'cache-control': 'max-age=3600',
          'content-type': 'application/octet-stream',
        },
        signal: putCtrl.signal,
      })
      putStatus = putRs.status
      if (!putRs.ok) {
        const t = await putRs.text().catch(() => '')
        return {
          ok: false,
          message: `Upload lên storage thất bại (HTTP ${putRs.status}): ${String(t).replace(/\s+/g, ' ').slice(0, 240)}`,
        }
      }
    } catch (putErr) {
      const aborted = putErr?.name === 'AbortError'
      return {
        ok: false,
        message: aborted
          ? 'Hết thời gian khi upload lên storage (gói quá lớn hoặc mạng chậm).'
          : (putErr?.message || 'Upload storage lỗi'),
      }
    } finally {
      clearTimeout(putTimer)
    }

    const commitRs = await postJson(
      `${baseUrl}/api/cloud-sync/upload-commit`,
      {
        sessionId: state.sessionId,
        objectPath,
        checksumSha256: pack.checksumSha256,
        profileCount: pack.count,
        byteLength,
        fileName,
        format: PORTABLE_PACKAGE_FORMAT,
        version: 2,
      },
      { headers, timeoutMs: 90000 },
    )
    const httpOk = !!commitRs.ok
    const apiOk = commitRs?.body?.ok === true
    const ok = httpOk && apiOk
    let message = typeof commitRs.body?.message === 'string' ? commitRs.body.message : ''
    if (!ok && !message) {
      if (!httpOk && commitRs.status) message = `Máy chủ trả HTTP ${commitRs.status}`
      else message = 'Không ghi nhận backup sau upload'
    }

    if (!silent) {
      logRuntime('cloud-upload', {
        ok: apiOk,
        httpStatus: commitRs.status,
        putStatus,
        count: pack.count,
        format: 'desktop-package-storage',
        bytes: byteLength,
        objectPath,
      })
    }

    return {
      ok,
      profileCount: Number(commitRs?.body?.profileCount || pack.count),
      message: ok ? undefined : message,
    }
  } catch (err) {
    return { ok: false, message: err?.message || 'Upload thất bại' }
  }
}

async function wipeAllLocalProfiles() {
  ensureDir(PROFILES_DIR)
  const names = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  for (const name of names) {
    try {
      const killRs = await cloneRuntime.terminatePcProfile(name, {
        profileDir: profileDir(name),
        logger: (event, info) => logRuntime(event, info),
      })
      logRuntime('pc-profile-terminate-before-wipe', { profileName: name, ...killRs })
    } catch (err) {
      logRuntime('pc-profile-terminate-before-wipe-error', { profileName: name, message: err?.message || 'unknown' })
    }
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

    const storageRef = rs.body.desktopPackageStorage
    const dlUrl = storageRef && typeof storageRef.signedDownloadUrl === 'string' ? storageRef.signedDownloadUrl.trim() : ''
    if (dlUrl) {
      const expected = String(storageRef.checksumSha256 || '').toLowerCase()
      const dlCtrl = new AbortController()
      const dlTimer = setTimeout(() => dlCtrl.abort(), 600000)
      try {
        const dl = await fetch(dlUrl, { signal: dlCtrl.signal })
        if (!dl.ok) {
          const t = await dl.text().catch(() => '')
          return {
            ok: false,
            message: `Tải backup HTTP ${dl.status}: ${String(t).replace(/\s+/g, ' ').slice(0, 240)}`,
          }
        }
        const raw = Buffer.from(await dl.arrayBuffer())
        if (expected) {
          const actual = crypto.createHash('sha256').update(raw).digest('hex')
          if (actual !== expected) return { ok: false, message: 'Checksum cloud package mismatch' }
        }
        const importRs = await importDesktopProfilesBuffer(raw, storageRef.fileName || 'cloud-backup.zmb', { bypassQuota: true })
        if (!importRs.ok) return importRs
        logRuntime('cloud-download', {
          imported: importRs.count || 0,
          uploadedAt: rs.body.uploadedAt,
          format: 'desktop-package-storage',
        })
        mainWindow?.webContents.send('profiles-reloaded')
        return { ok: true, imported: importRs.count || 0, uploadedAt: rs.body.uploadedAt }
      } catch (dlErr) {
        const aborted = dlErr?.name === 'AbortError'
        return {
          ok: false,
          message: aborted ? 'Hết thời gian khi tải backup từ storage.' : (dlErr?.message || 'Download storage lỗi'),
        }
      } finally {
        clearTimeout(dlTimer)
      }
    }

    const desktopPackage = rs.body.desktopPackage
    if (desktopPackage?.dataBase64) {
      const raw = Buffer.from(String(desktopPackage.dataBase64), 'base64')
      const expected = String(desktopPackage.checksumSha256 || '').toLowerCase()
      if (expected) {
        const actual = crypto.createHash('sha256').update(raw).digest('hex')
        if (actual !== expected) return { ok: false, message: 'Checksum cloud package mismatch' }
      }
      const importRs = await importDesktopProfilesBuffer(raw, desktopPackage.fileName || 'cloud-backup.zmb', { bypassQuota: true })
      if (!importRs.ok) return importRs
      logRuntime('cloud-download', { imported: importRs.count || 0, uploadedAt: rs.body.uploadedAt, format: 'desktop-package' })
      mainWindow?.webContents.send('profiles-reloaded')
      return { ok: true, imported: importRs.count || 0, uploadedAt: rs.body.uploadedAt }
    }

    // Legacy cloud payload fallback (profiles_json array).
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
    const count = Number(
      rs.body?.desktopPackageStorage?.profileCount
      || rs.body?.desktopPackage?.profileCount
      || rs.body?.profileCount
      || 0,
    )
    return { ok: true, hasBackup: count > 0, profileCount: count, uploadedAt: rs.body.uploadedAt }
  } catch (err) {
    return { ok: false, hasBackup: false, message: err?.message }
  }
})

ipcMain.handle('create-profile-shortcut', async (_event, payload) => {
  try {
    const profileName = String(payload?.profileName || '').trim()
    if (!profileName) return { ok: false, message: 'Thiếu profileName' }
    const meta = loadProfileMeta(profileName)
    if (!meta) return { ok: false, message: 'Không tìm thấy profile' }

    const desktopDir = path.join(os.homedir(), 'Desktop')
    ensureDir(desktopDir)
    const shortcutName = `ZaloMask - ${sanitizeWindowsFileName(meta.displayName || profileName)}.lnk`
    const shortcutPath = path.join(desktopDir, shortcutName)
    const targetPath = app.isPackaged ? app.getPath('exe') : process.execPath
    const args = buildShortcutArguments(profileName)
    const workingDirectory = app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..')
    const iconPath = fs.existsSync(APP_ICON) ? APP_ICON : targetPath

    createWindowsShortcut(shortcutPath, targetPath, args, workingDirectory, iconPath)
    return { ok: true, filePath: shortcutPath }
  } catch (error) {
    return { ok: false, message: error?.message || 'Không tạo được shortcut' }
  }
})

ipcMain.on('close-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
})

ipcMain.on('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
})

// One-shot smoke test: pick the first existing PC profile that has a
// `Local State` file and try to extract its DPAPI-protected cookie key.
// Result is cached in config (`dpapiSmokeTest.lastOk` + `lastAt`) so we
// don't spawn PowerShell every boot — only re-probe if we've never seen
// success or the cached result is older than 7 days.
const DPAPI_SMOKE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
function runDpapiSmokeTest() {
  if (process.platform !== 'win32') {
    logRuntime('dpapi-key-extract-test', { ok: false, skipped: true, reason: 'non-windows' })
    return
  }
  try {
    const config = readConfig() || {}
    const cached = config.dpapiSmokeTest && typeof config.dpapiSmokeTest === 'object' ? config.dpapiSmokeTest : null
    const lastAtMs = cached && Number.isFinite(Number(cached.lastAtMs)) ? Number(cached.lastAtMs) : 0
    const stale = !lastAtMs || (Date.now() - lastAtMs) > DPAPI_SMOKE_CACHE_TTL_MS
    if (cached && cached.lastOk === true && !stale) {
      logRuntime('dpapi-key-extract-test', { ok: true, cached: true, lastAtMs })
      return
    }

    if (!fs.existsSync(PROFILES_DIR)) {
      logRuntime('dpapi-key-extract-test', { ok: false, skipped: true, reason: 'no-profiles-dir' })
      return
    }
    const dirEntries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    let probedProfile = null
    for (const name of dirEntries) {
      const roaming = path.join(profileDir(name), 'AppData', 'Roaming')
      if (findNamedFilesUnderDir(roaming, 'local state', 22).length > 0) {
        probedProfile = name
        break
      }
    }
    if (!probedProfile) {
      logRuntime('dpapi-key-extract-test', { ok: false, skipped: true, reason: 'no-local-state-found' })
      return
    }
    const key = extractPortableProfileCookieKeyB64(profileDir(probedProfile), { profileName: probedProfile })
    const keyLength = key ? Buffer.from(String(key), 'base64').length : 0
    const ok = !!key && keyLength === 32
    // Never log the raw key — only its length, so we can confirm 32-byte AES
    // material without leaking credentials into the runtime log.
    logRuntime('dpapi-key-extract-test', { ok, profile: probedProfile, keyLength })

    // Persist outcome so future boots skip the PowerShell spawn when we know
    // DPAPI works on this machine. Re-probe weekly (TTL) or on first failure.
    try {
      const next = { ...config }
      next.dpapiSmokeTest = { lastOk: ok, lastAtMs: Date.now(), keyLength }
      writeConfig(next)
    } catch (_) {}
  } catch (error) {
    logRuntime('dpapi-key-extract-test', { ok: false, error: String(error?.message || error) })
  }
}

app.whenReady().then(async () => {
  if (diagnosticsExportCliPath) {
    try {
      ensureDir(PROFILES_DIR)
      await exportDiagnosticsToZipFile(diagnosticsExportCliPath)
      logRuntime('diagnostics-export-cli-ok', { path: diagnosticsExportCliPath })
      await dialog.showMessageBox({
        type: 'info',
        title: 'ZaloMask',
        message: 'Đã xuất báo cáo chẩn đoán.',
        detail: diagnosticsExportCliPath,
      })
      shell.showItemInFolder(diagnosticsExportCliPath)
    } catch (e) {
      const msg = e?.message || String(e)
      logRuntime('diagnostics-export-cli-fail', { message: msg })
      try {
        dialog.showErrorBox('Xuất chẩn đoán thất bại', msg)
      } catch (_) {}
    }
    app.quit()
    return
  }

  ensureDir(PROFILES_DIR)
  logRuntime('app-ready')
  createMainWindow()
  bootLicenseRuntime()
  // Proactively patch Zalo runtime on boot so fresh machines always get the
  // clone shim synced (even if proxy checks fail or user never enables privacy).
  setTimeout(async () => {
    try {
      const rs = await ensurePcRuntimePatchReady('boot')
      logRuntime('asar-patch-boot', {
        ok: !!rs.ok,
        skipped: !!asarPatchState?.skipped,
        reason: asarPatchState?.reason || '',
        message: rs.ok ? (asarPatchState?.message || '') : (rs.message || asarPatchState?.message || ''),
      })
    } catch (e) {
      logRuntime('asar-patch-boot-error', { message: e?.message || String(e) })
    }
  }, 1200)
  // Defer the DPAPI probe so it doesn't block first-paint of the window.
  setTimeout(() => {
    try { runDpapiSmokeTest() } catch (_) {}
  }, 2000)
  try {
    autoUpdate.registerIpc({ configPath: CONFIG_PATH })
    autoUpdate.startBackgroundChecks({ configPath: CONFIG_PATH })
  } catch (error) {
    logRuntime('auto-update-boot-error', { message: error?.message || String(error) })
  }

  if (startupOpenProfileName) {
    setTimeout(async () => {
      try {
        const meta = loadProfileMeta(startupOpenProfileName)
        if (!meta) {
          logRuntime('startup-open-profile-not-found', { profileName: startupOpenProfileName })
          return
        }
        const patchRs = await ensurePcRuntimePatchReady('startup-open-profile')
        if (!patchRs.ok) {
          logRuntime('startup-open-profile-patch-failed', {
            profileName: startupOpenProfileName,
            message: patchRs.message || 'unknown',
          })
          return
        }
        const rs = await cloneRuntime.launchPcProfile(startupOpenProfileName, {
          meta,
          profileDir: profileDir(startupOpenProfileName),
          logger: (event, info) => logRuntime(event, info),
        })
        if (!rs?.ok) {
          logRuntime('startup-open-profile-failed', { profileName: startupOpenProfileName, message: rs?.message || 'unknown' })
        } else {
          logRuntime('startup-open-profile-ok', { profileName: startupOpenProfileName, pid: rs.pid })
        }
      } catch (error) {
        logRuntime('startup-open-profile-error', { profileName: startupOpenProfileName, message: error?.message || 'unknown' })
      }
    }, 1000)
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


