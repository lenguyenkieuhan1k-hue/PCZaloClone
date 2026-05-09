'use strict'

/* PC mode runtime — launch bundled Zalo.exe with isolated desktop data
 * directories per profile.
 *
 * This follows the same core idea as ZaloMulti-Win:
 *   1. Each profile gets its own USERPROFILE/AppData tree.
 *   2. Zalo.exe runs with APPDATA / LOCALAPPDATA pointing at that tree.
 *   3. No app.asar patching is required for profile isolation.
 *
 * This is intentionally simpler and more robust than patching Zalo's internals. */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const net = require('net')
const { app, dialog } = require('electron')
const { spawn, spawnSync } = require('child_process')
const { startProxyBridge: startProxyBridgeNormal } = require('../proxy-bridge')
const { startProxyBridge: startProxyBridgeVerbose } = require('../proxy-bridge-verbose')

const RUNTIME_DIR_NAME = 'zalo-runtime'
const PATCH_STAMP_FILENAME = '.zalomask-patched'
const PATCH_VERSION = 13

let cachedZaloRuntimeDir = null
/** When bundled app.asar is read-only, user-runtime copy failed; never fall back to Program Files for patch. */
let lastRuntimePickFailure = null
let cachedPatchCheck = {
  asarPath: '',
  patchVersion: 0,
  applied: false,
}
const activeProxyBridges = new Map()

function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const testFile = path.join(dir, `.write-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`)
    fs.writeFileSync(testFile, 'ok', 'utf8')
    fs.unlinkSync(testFile)
    return true
  } catch {
    return false
  }
}

function getUserRuntimeRoot() {
  // Large Zalo bundle: prefer LocalAppData (not Roaming / cloud-synced folders).
  const local = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA.trim() : ''
  if (local) return path.join(local, 'ZaloMask', 'runtime')
  let base = ''
  try { base = app.getPath('userData') } catch { base = '' }
  if (!base) base = process.env.APPDATA ? path.join(process.env.APPDATA, 'ZaloMask') : (process.env.TEMP || 'C:\\Temp')
  return path.join(base, 'runtime')
}

/** Windows: robocopy tolerates ACLs and huge trees better than fs.cp on some machines. */
function copyRuntimeTreeRobocopy(src, dst, logger) {
  try {
    logger('pc-runtime-copy-robocopy', { from: src, to: dst })
  } catch (_) {}
  const rc = spawnSync(
    'robocopy.exe',
    [src, dst, '/E', '/COPY:DAT', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS'],
    { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 10 * 1024 * 1024 },
  )
  const code = typeof rc.status === 'number' ? rc.status : -1
  const tail = String(rc.stdout || rc.stderr || '').trim().slice(-800)
  // MS: exit >= 8 means failure (copy errors / locked files).
  if (code >= 8) {
    throw new Error('robocopy exit=' + code + ' ' + tail)
  }
}
/** Best-effort remove or rename-away a previous user-runtime tree (handles EBUSY / locked asar). */
async function wipeUserRuntimeDest(dst, logger = () => {}) {
  if (!dst || !fs.existsSync(dst)) return true

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      fs.rmSync(dst, { recursive: true, force: true })
      return true
    } catch (e) {
      try {
        logger('pc-runtime-wipe-attempt', { attempt, message: e?.message || String(e), code: e?.code })
      } catch (_) {}
      if (attempt < 4) await sleep(750)
    }
  }

  if (process.platform === 'win32') {
    try {
      const escaped = String(dst).replace(/'/g, "''")
      const rs = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction Stop`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 },
      )
      if (!fs.existsSync(dst)) return true
      try {
        logger('pc-runtime-wipe-powershell-failed', {
          exit: rs.status,
          tail: String(rs.stderr || rs.stdout || '').slice(0, 400),
        })
      } catch (_) {}
    } catch (e) {
      try { logger('pc-runtime-wipe-powershell-error', { message: e?.message || String(e) }) } catch (_) {}
    }
  }

  if (fs.existsSync(dst)) {
    try {
      const abandoned = `${dst}.abandoned-${Date.now()}`
      fs.renameSync(dst, abandoned)
      try { logger('pc-runtime-wipe-renamed-leave-behind', { from: dst, to: abandoned }) } catch (_) {}
      return true
    } catch (e) {
      try { logger('pc-runtime-wipe-rename-failed', { message: e?.message || String(e) }) } catch (_) {}
    }
  }

  return !fs.existsSync(dst)
}

function userRuntimeCopyLooksComplete(dst) {
  const marker = path.join(dst, '.runtime-copied')
  const exe = path.join(dst, 'Zalo.exe')
  if (!fs.existsSync(exe) || !fs.existsSync(marker)) return false
  const asar = resolveBundledZaloAsarInDir(dst)
  if (!asar || !fs.existsSync(asar)) return false
  try {
    return fs.statSync(asar).isFile()
  } catch {
    return false
  }
}

async function copyRuntimeTreeAsync(src, dst, logger) {
  if (fs.existsSync(dst)) {
    const wiped = await wipeUserRuntimeDest(dst, logger)
    if (!wiped) {
      throw new Error(
        'EBUSY hoặc file đang khóa (thường do Zalo.exe đang chạy từ bản copy cũ). ' +
          'Tắt hết Zalo PC / Task Manager (Zalo.exe), đóng ZaloMask, xóa tay thư mục: ' + dst,
      )
    }
    try {
      logger('pc-runtime-copy-wiped-dest', { to: dst })
    } catch (_) {}
  }
  const tryNodeCp = async () => {
    const fsp = fs.promises
    if (fsp && typeof fsp.cp === 'function') {
      await fsp.cp(src, dst, { recursive: true, force: true })
      return
    }
    await new Promise((resolve, reject) => {
      try {
        if (typeof fs.cpSync === 'function') {
          fs.cpSync(src, dst, { recursive: true, force: true })
        } else {
          const copyDir = (s, d) => {
            fs.mkdirSync(d, { recursive: true })
            for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
              const ss = path.join(s, ent.name)
              const dd = path.join(d, ent.name)
              if (ent.isDirectory()) copyDir(ss, dd)
              else fs.copyFileSync(ss, dd)
            }
          }
          copyDir(src, dst)
        }
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  }

  let firstErr = null
  try {
    await tryNodeCp()
    return
  } catch (e) {
    firstErr = e
    const detail = {
      message: e?.message || String(e),
      code: e?.code,
      errno: e?.errno,
      syscall: e?.syscall,
      path: e?.path,
    }
    try {
      logger('pc-runtime-copy-node-failed', detail)
    } catch (_) {}
  }

  if (process.platform === 'win32') {
    try {
      if (fs.existsSync(dst)) {
        const w = await wipeUserRuntimeDest(dst, logger)
        if (!w) {
          throw new Error('Không dọn được thư mục đích sau copy lỗi (EBUSY). Tắt Zalo.exe rồi thử lại.')
        }
        try {
          logger('pc-runtime-copy-wiped-partial', { to: dst })
        } catch (_) {}
      }
      copyRuntimeTreeRobocopy(src, dst, logger)
      return
    } catch (e2) {
      const msg2 = e2?.message || String(e2)
      try {
        logger('pc-runtime-copy-robocopy-failed', { message: msg2.slice(0, 600) })
      } catch (_) {}
      const merged = (firstErr && firstErr.message) ? firstErr.message + ' | ' + msg2 : msg2
      throw new Error(merged)
    }
  }
  throw firstErr || new Error('copy failed')
}

async function ensureWritableRuntimeDirAsync(runtimeDir, logger = () => {}, opts = {}) {
  const src = String(runtimeDir || '')
  if (!src) return { ok: false, runtimeDir: null, source: 'missing' }
  const forceCopy = !!(opts && opts.forceCopy)
  if (!forceCopy && isDirWritable(src)) return { ok: true, runtimeDir: src, source: 'original' }

  const dstRoot = getUserRuntimeRoot()
  const dst = path.join(dstRoot, RUNTIME_DIR_NAME)
  try { fs.mkdirSync(dstRoot, { recursive: true }) } catch {}

  const marker = path.join(dst, '.runtime-copied')
  const needCopy = !userRuntimeCopyLooksComplete(dst)
  if (needCopy) {
    try {
      logger('pc-runtime-copy-start', { from: src, to: dst })
      await copyRuntimeTreeAsync(src, dst, logger)
      try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8') } catch {}
      logger('pc-runtime-copy-done', { to: dst })
    } catch (e) {
      const detail = {
        message: e?.message || String(e),
        code: e?.code,
        errno: e?.errno,
        from: src,
        to: dst,
      }
      logger('pc-runtime-copy-failed', detail)
      return { ok: false, runtimeDir: null, source: 'copy-failed', copyError: detail.message }
    }
  }

  if (!isDirWritable(dst)) {
    logger('pc-runtime-not-writable', { runtimeDir: dst })
    return { ok: false, runtimeDir: null, source: 'dest-not-writable' }
  }
  return { ok: true, runtimeDir: dst, source: 'user-runtime' }
}

function testLocalProxyBridge(listenHost, listenPort) {
  const host = String(listenHost || '127.0.0.1')
  const port = Number(listenPort || 0)
  if (!port || port <= 0) return { ok: false, message: 'Invalid local proxy bridge port' }
  // Don't use curl here: curl timeouts hide the true failure mode (CONNECT
  // status line vs upstream silence). Probe the bridge with a raw CONNECT.
  const target = 'api.ipify.org:443'
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { socket.destroy() } catch (_) {}
      resolve(result)
    }

    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      finish({ ok: false, message: 'Bridge CONNECT timeout (no response)' })
    }, 4000)

    let buffer = Buffer.alloc(0)
    socket.on('connect', () => {
      const req = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        'Proxy-Connection: Keep-Alive',
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n')
      socket.write(req)
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const marker = buffer.indexOf('\r\n\r\n')
      if (marker === -1) return
      clearTimeout(timer)
      const headerText = buffer.slice(0, marker).toString('utf8')
      const statusLine = headerText.split('\r\n')[0] || ''
      const ok = /\s200\s/i.test(statusLine)
      if (ok) return finish({ ok: true })
      return finish({ ok: false, message: statusLine || 'CONNECT failed' })
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, message: (err?.message || 'bridge socket error').slice(0, 240) })
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (!done) finish({ ok: false, message: 'Bridge socket closed' })
    })
  })
}

function ensureDir(dir) {
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
}

function getActiveProxyBridge(profileName) {
  return activeProxyBridges.get(String(profileName || '')) || null
}

async function stopProxyBridgeForProfile(profileName, logger = () => {}) {
  const key = String(profileName || '')
  const bridge = activeProxyBridges.get(key)
  if (!bridge) return { ok: true, stopped: false, reason: 'not-running' }
  activeProxyBridges.delete(key)
  try {
    await bridge.close()
    logger('pc-proxy-bridge-stopped', { profileName: key, port: bridge.port, upstream: bridge.upstream })
    return { ok: true, stopped: true, port: bridge.port }
  } catch (error) {
    logger('pc-proxy-bridge-stop-failed', { profileName: key, port: bridge.port, message: error?.message || 'unknown' })
    return { ok: false, stopped: false, message: error?.message || 'unknown', port: bridge.port }
  }
}

async function ensureProxyBridge(profileName, proxy, logger = () => {}) {
  const key = String(profileName || '')
  const upstream = {
    protocol: String(proxy?.protocol || 'HTTP').toUpperCase(),
    host: String(proxy?.host || '').trim(),
    port: Number(proxy?.port || 0),
    authEnabled: !!proxy?.authEnabled,
    username: String(proxy?.username || ''),
    password: String(proxy?.password || ''),
  }
  const current = activeProxyBridges.get(key)
  if (
    current &&
    current.upstream &&
    current.upstream.protocol === upstream.protocol &&
    current.upstream.host === upstream.host &&
    current.upstream.port === upstream.port &&
    current.upstream.authEnabled === upstream.authEnabled &&
    current.upstream.username === upstream.username &&
    current.upstream.password === upstream.password
  ) {
    return current
  }

  if (current) await stopProxyBridgeForProfile(key, logger)

  // Optional verbose logging to diagnose CONNECT behavior.
  // Default OFF in production — the verbose bridge writes to disk on every
  // CONNECT request which adds overhead. Set ZALOMASK_PROXY_BRIDGE_VERBOSE=1
  // to opt in (recommended only when debugging proxy auth issues).
  const verboseEnv = String(process.env.ZALOMASK_PROXY_BRIDGE_VERBOSE || '').trim().toLowerCase()
  const wantVerbose = verboseEnv === '1' || verboseEnv === 'true' || verboseEnv === 'yes'
  let bridgeLogFile = null
  if (wantVerbose) {
    try {
      const programData = process.env.ProgramData || 'C:\\ProgramData'
      const dir = path.join(programData, 'ZaloMask', 'proxy')
      fs.mkdirSync(dir, { recursive: true })
      bridgeLogFile = path.join(dir, `${key}.bridge.log`)
      // Truncate previous log so we only see the current session.
      try { fs.writeFileSync(bridgeLogFile, '', 'utf8') } catch (_) {}
      logger('pc-proxy-bridge-verbose-enabled', { profileName: key, logFile: bridgeLogFile })
    } catch (_) {}
  }

  const bridge = await (wantVerbose
    ? startProxyBridgeVerbose(proxy, { logFile: bridgeLogFile })
    : startProxyBridgeNormal(proxy))
  const test = await testLocalProxyBridge(bridge.host, bridge.port)
  if (!test?.ok) {
    try { await bridge.close() } catch (_) {}
    logger('pc-proxy-bridge-test-failed', {
      profileName: key,
      listenHost: bridge.host,
      listenPort: bridge.port,
      upstream,
      message: test?.message || 'unknown',
    })
    throw new Error('Proxy bridge self-test failed: ' + (test?.message || 'unknown'))
  }
  const record = {
    ...bridge,
    upstream,
  }
  activeProxyBridges.set(key, record)

  logger('pc-proxy-bridge-started', {
    profileName: key,
    listenHost: bridge.host,
    listenPort: bridge.port,
    upstream,
    testOk: true,
  })
  return record
}

function isDev() {
  // app.isPackaged is the canonical Electron flag; fall back to NODE_ENV check.
  try { return !app.isPackaged } catch (_) { return process.env.NODE_ENV !== 'production' }
}

/** Resolve the absolute path to bundled Zalo runtime root (folder containing Zalo.exe). */
function resolveZaloRuntimeDir() {
  if (cachedZaloRuntimeDir && fs.existsSync(cachedZaloRuntimeDir)) {
    return cachedZaloRuntimeDir
  }

  const candidates = []
  if (isDev()) {
    // Dev: app/zalo-runtime/ next to clone/
    candidates.push(path.join(__dirname, '..', RUNTIME_DIR_NAME))
  }
  // Production: extraResources lands under resourcesPath
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, RUNTIME_DIR_NAME))
  }
  // Belt-and-suspenders: also check beside app dir (for user-configured custom location)
  candidates.push(path.join(path.dirname(app.getPath('exe') || ''), RUNTIME_DIR_NAME))

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'Zalo.exe'))) {
      cachedZaloRuntimeDir = dir
      return dir
    }
  }
  return null
}

/** Locate the app.asar inside the bundled Zalo runtime. Zalo's installer
 *  sometimes nests resources/app.asar; sometimes its app-X.Y.Z/resources/.
 *  Search depth 3 is enough. */
function resolveBundledZaloAsarInDir(root) {
  const dirRoot = String(root || '')
  if (!dirRoot) return null
  const queue = [dirRoot]
  let depth = 0
  while (queue.length && depth < 6) {
    const next = []
    for (const dir of queue) {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name === 'app.asar') {
          if (path.basename(path.dirname(full)).toLowerCase() === 'resources') return full
        } else if (e.isDirectory()) {
          next.push(full)
        }
      }
    }
    queue.length = 0
    queue.push(...next)
    depth++
  }
  // Fallback: any app.asar inside runtime
  const find = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isFile() && e.name === 'app.asar') return full
      if (e.isDirectory()) {
        const r = find(full)
        if (r) return r
      }
    }
    return null
  }
  try { return find(dirRoot) } catch { return null }
}

async function pickRuntimeDirAsync(logger = () => {}) {
  lastRuntimePickFailure = null
  const raw = resolveZaloRuntimeDir()
  if (!raw) return null

  const asar = resolveBundledZaloAsarInDir(raw)
  if (asar && fs.existsSync(asar) && !canWriteFile(asar)) {
    try {
      if (isPatchApplied(asar)) {
        try { logger('pc-runtime-bundle-pre-patched-readonly', { asarPath: asar }) } catch (_) {}
        cachedZaloRuntimeDir = raw
        return raw
      }
    } catch (_) {}
    const picked = await ensureWritableRuntimeDirAsync(raw, logger, { forceCopy: true })
    if (picked && picked.ok && picked.runtimeDir) {
      try { logger('pc-runtime-picked', { from: raw, to: picked.runtimeDir, reason: 'asar-not-writable' }) } catch {}
      cachedZaloRuntimeDir = picked.runtimeDir
      return picked.runtimeDir
    }
    const userDest = path.join(getUserRuntimeRoot(), RUNTIME_DIR_NAME)
    lastRuntimePickFailure = {
      kind: 'user-copy-failed',
      source: picked?.source || 'unknown',
      copyError: picked?.copyError || '',
      bundleAsar: asar,
      userDest,
    }
    try {
      logger('pc-runtime-must-copy-failed', {
        source: lastRuntimePickFailure.source,
        copyError: lastRuntimePickFailure.copyError,
        bundleAsar: asar,
        userDest,
      })
    } catch (_) {}
    return null
  }

  cachedZaloRuntimeDir = raw
  return raw
}

async function resolveBundledZaloAsar() {
  const root = await pickRuntimeDirAsync(() => {})
  if (!root) return null
  return resolveBundledZaloAsarInDir(root)
}

function getPatchStampPath(asarPath) {
  return asarPath + PATCH_STAMP_FILENAME
}

function copyFileIfChanged(src, dest) {
  try {
    const srcStat = fs.statSync(src)
    try {
      const dstStat = fs.statSync(dest)
      if (srcStat.size === dstStat.size && Number(srcStat.mtimeMs || 0) <= Number(dstStat.mtimeMs || 0)) {
        return true
      }
    } catch {}
    fs.copyFileSync(src, dest)
    return true
  } catch {
    return false
  }
}

function isPatchApplied(asarPath) {
  try {
    if (
      cachedPatchCheck.applied &&
      cachedPatchCheck.asarPath === asarPath &&
      cachedPatchCheck.patchVersion === PATCH_VERSION
    ) {
      return true
    }
    const stampPath = getPatchStampPath(asarPath)
    if (!fs.existsSync(stampPath)) return false
    const raw = fs.readFileSync(stampPath, 'utf8').trim()
    if (!raw.startsWith('{')) return false
    const stamp = JSON.parse(raw)
    if (Number(stamp.version || 0) < PATCH_VERSION) return false
    cachedPatchCheck = { asarPath, patchVersion: PATCH_VERSION, applied: true }
    return true
  } catch { return false }
}

function canWriteFile(pathLike) {
  try {
    const fd = fs.openSync(pathLike, 'r+')
    try { fs.closeSync(fd) } catch {}
    return true
  } catch {
    return false
  }
}

/** Patch the bundled Zalo's app.asar with our shim. Idempotent + stamped. */
async function ensureAsarPatched(logger = () => {}) {
  const runtimeDir = await pickRuntimeDirAsync(logger)
  const status = buildRuntimeStatus(runtimeDir)
  if (!status.ok) {
    return { ok: false, message: status.message || 'Runtime Zalo PC chưa sẵn sàng.' }
  }
  const asarPath = status.asarPath
  if (!asarPath || !status.asarExists) {
    return { ok: false, message: 'Không tìm thấy app.asar của Zalo PC.' }
  }

  // Copy shims to a stable absolute path so Zalo's bootstrap can `require()`
  // them after patching. ProgramData is preferred, but on some machines it can
  // be blocked (policy/AV/permission). If ProgramData is not writable, fall
  // back to the app's per-user data dir (always writable).
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const shimDirPrimary = path.join(programData, 'ZaloMask', 'shim')
  const shimDirFallback = path.join(app.getPath('userData') || path.join(process.env.APPDATA || programData, 'ZaloMask'), 'shim')
  let shimDir = shimDirPrimary
  let shimDirSource = 'programdata'
  try {
    fs.mkdirSync(shimDirPrimary, { recursive: true })
  } catch (_) {
    shimDir = shimDirFallback
    shimDirSource = 'userData'
    try { fs.mkdirSync(shimDir, { recursive: true }) } catch {}
  }

  const privacyShimSrc = path.join(__dirname, 'privacy-shim.js')
  const cloneShimSrc = path.join(__dirname, 'clone-main-shim.js')
  const privacyShimDest = path.join(shimDir, 'privacy-shim.js')
  const cloneShimDest = path.join(shimDir, 'clone-main-shim.js')

  const copiedOk = copyFileIfChanged(privacyShimSrc, privacyShimDest) && copyFileIfChanged(cloneShimSrc, cloneShimDest)
  if (!copiedOk && shimDir === shimDirPrimary) {
    // Primary failed → retry fallback.
    shimDir = shimDirFallback
    shimDirSource = 'userData'
    try { fs.mkdirSync(shimDir, { recursive: true }) } catch {}
  }
  const privacyShimDest2 = path.join(shimDir, 'privacy-shim.js')
  const cloneShimDest2 = path.join(shimDir, 'clone-main-shim.js')
  const copiedOk2 = copyFileIfChanged(privacyShimSrc, privacyShimDest2) && copyFileIfChanged(cloneShimSrc, cloneShimDest2)
  if (!copiedOk2) {
    return { ok: false, message: 'Không thể đồng bộ shim vào ProgramData hoặc userData.' }
  }
  try {
    logger('asar-shim-synced', { shimDir, shimDirSource, cloneShimDest: cloneShimDest2 })
  } catch {}

  if (isPatchApplied(asarPath)) {
    logger('asar-already-patched', { asarPath, patchVersion: PATCH_VERSION })
    return { ok: true, skipped: true, reason: 'already-patched' }
  }

  const backupPath = asarPath + '.backup'
  const stampPath = getPatchStampPath(asarPath)
  const extractDest = path.join(runtimeDir, '.asar-extract')
  const repackedDest = path.join(runtimeDir, 'app-repacked.asar')
  const donePath = path.join(runtimeDir, '.asar-patch-done.txt')

  try { fs.unlinkSync(donePath) } catch {}

  const patcherScript = path.join(__dirname, 'asar-patcher.js')
  const args = [
    asarPath, backupPath, stampPath, extractDest, repackedDest,
    'main-dist/preload-render.js', privacyShimDest2, '// [ZaloMask-privacy-v' + PATCH_VERSION + ']',
    'bootstrap.js', cloneShimDest2, '// [ZaloMask-clone-v' + PATCH_VERSION + ']',
    String(PATCH_VERSION), donePath,
  ]

  logger('asar-patch-starting', { asarPath, patchVersion: PATCH_VERSION })

  return new Promise((resolve) => {
    let child
    try {
      if (!canWriteFile(asarPath)) {
        logger('asar-patch-not-writable', { asarPath })
        resolve({ ok: false, message: 'asar-not-writable' })
        return
      }
      child = spawn(process.execPath, [patcherScript, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
        stdio: 'ignore',
      })
    } catch (e) {
      resolve({ ok: false, message: 'Không thể khởi động asar-patcher: ' + e.message })
      return
    }

    const timeout = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, message: 'asar-patcher timeout (>120s)' })
    }, 120000)

    child.on('exit', (code) => {
      clearTimeout(timeout)
      let doneMsg = ''
      try { doneMsg = fs.readFileSync(donePath, 'utf8').trim() } catch {}
      if (doneMsg === 'ok' && code === 0) {
        cachedPatchCheck = { asarPath, patchVersion: PATCH_VERSION, applied: true }
        logger('asar-patch-done', { asarPath })
        resolve({ ok: true })
      } else {
        if (isPatchApplied(asarPath)) {
          cachedPatchCheck = { asarPath, patchVersion: PATCH_VERSION, applied: true }
          logger('asar-patch-failed-but-stamped', { asarPath, exitCode: code, doneMsg })
          resolve({ ok: true, skipped: true, reason: 'failed-but-stamped' })
          return
        }
        const message = doneMsg && doneMsg.startsWith('error:') ? doneMsg.slice(6) : ('exit=' + code)
        logger('asar-patch-failed', { message, exitCode: code, doneMsg })
        resolve({ ok: false, message })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      logger('asar-patch-error', { message: err.message })
      resolve({ ok: false, message: err.message })
    })
  })
}

function ensureStableDeviceFiles(profileRoot) {
  const roamingPath = path.join(profileRoot, 'AppData', 'Roaming')
  const zaloDataPath = path.join(roamingPath, 'ZaloData')
  ensureDir(roamingPath)
  ensureDir(zaloDataPath)

  const zuFile = path.join(roamingPath, 'z_u.txt')
  if (!fs.existsSync(zuFile)) {
    const randomPart1 = Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join('')
    const timestamp = Date.now()
    const randomHash = crypto.randomUUID().replace(/-/g, '')
    fs.writeFileSync(zuFile, `${randomPart1}.${timestamp}.${randomHash}`, 'ascii')
  }

  const configPath = path.join(zaloDataPath, 'config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ zalo_installed: Date.now() }), 'utf8')
  }
}

function resolveProfileDesktopEnv(profileName, opts = {}) {
  const explicitProfileDir = String(opts.profileDir || '').trim()
  const baseRoot = explicitProfileDir
    ? explicitProfileDir
    : path.join(app.getPath('userData'), 'desktop-profiles', String(profileName || 'profile'))

  const profileRoot = path.resolve(baseRoot)
  const roamingPath = path.join(profileRoot, 'AppData', 'Roaming')
  const localPath = path.join(profileRoot, 'AppData', 'Local')
  const zaloDataPath = path.join(roamingPath, 'ZaloData')
  ensureDir(profileRoot)
  ensureDir(roamingPath)
  ensureDir(localPath)
  ensureDir(zaloDataPath)
  ensureStableDeviceFiles(profileRoot)
  return {
    profileRoot,
    roamingPath,
    localPath,
    zaloDataPath,
    pidFilePath: path.join(profileRoot, 'pid.txt'),
  }
}

/** Build a stable cloneId from a profileName (used as suffix for APPDATA per profile). */
function cloneIdFor(profileName) {
  return crypto.createHash('sha1').update(String(profileName)).digest('hex').slice(0, 16)
}

function buildPcProxyArg(proxy) {
  const src = proxy && typeof proxy === 'object' ? proxy : {}
  if (!src.enabled || !src.host || !src.port) return { ok: true, value: '--no-proxy-server', mode: 'direct' }

  const protocol = String(src.protocol || 'HTTP').toUpperCase()
  const isSocks5 = protocol === 'SOCKS5'
  if (src.authEnabled) {
    if (isSocks5) {
      return {
        ok: false,
        message: 'Zalo PC runtime hiện chỉ hỗ trợ proxy auth qua local bridge cho HTTP proxy. SOCKS5 auth chưa được hỗ trợ.',
      }
    }
    // Default: use local bridge to inject Proxy-Authorization. Some Zalo PC
    // builds exit immediately if credentials are embedded in --proxy-server URL.
    // Dev override: set ZALOMASK_PROXY_AUTH_MODE=url to try URL auth.
    const authMode = String(process.env.ZALOMASK_PROXY_AUTH_MODE || '').trim().toLowerCase()
    if (authMode === 'url') {
      const proto = protocol === 'HTTPS' ? 'https' : 'http'
      const user = String(src.username || '')
      const pass = String(src.password || '')
      const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`
      return { ok: true, value: `--proxy-server=${proto}://${auth}@${src.host}:${src.port}`, mode: 'upstream-direct-auth' }
    }
    return {
      ok: true,
      needsBridge: true,
      mode: 'bridge',
    }
  }

  const proto = isSocks5 ? 'socks5' : (protocol === 'HTTPS' ? 'https' : 'http')
  return { ok: true, value: `--proxy-server=${proto}://${src.host}:${src.port}`, mode: 'upstream-direct' }
}

function readProfilePid(profileName, opts = {}) {
  try {
    const desktopEnv = resolveProfileDesktopEnv(profileName, opts)
    const raw = fs.readFileSync(desktopEnv.pidFilePath, 'utf8').trim()
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, pid: 0, pidFilePath: desktopEnv.pidFilePath }
    return { ok: true, pid, pidFilePath: desktopEnv.pidFilePath }
  } catch (_) {
    const desktopEnv = resolveProfileDesktopEnv(profileName, opts)
    return { ok: false, pid: 0, pidFilePath: desktopEnv.pidFilePath }
  }
}

function getProcessExecutablePath(pid) {
  const rs = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' + Number(pid) + '" -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write($p.ExecutablePath) }',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  if (rs.error) return ''
  return String(rs.stdout || '').trim()
}

// The bundled Zalo runtime ships with a Squirrel-style top-level stub
// `<runtimeDir>/Zalo.exe` that just locates `<runtimeDir>/Zalo-X.Y.Z/Zalo.exe`,
// spawns it, and exits with code 0. Spawning the stub directly makes it
// look like the process died instantly (exitCode=0). To dodge that, prefer
// the versioned inner exe whenever we can find one — the stub is only
// needed for Start-menu shortcuts.
function resolveBundledZaloExe(runtimeDir) {
  if (!runtimeDir) return null
  const stubExe = path.join(runtimeDir, 'Zalo.exe')
  let entries = []
  try { entries = fs.readdirSync(runtimeDir, { withFileTypes: true }) } catch (_) { entries = [] }
  // Pick the highest-versioned `Zalo-x.y.z` folder. Sort by mtime + name fallback.
  const candidates = entries
    .filter((e) => e.isDirectory() && /^Zalo-\d+(\.\d+)+$/i.test(e.name))
    .map((e) => {
      const dir = path.join(runtimeDir, e.name)
      const exe = path.join(dir, 'Zalo.exe')
      let mtimeMs = 0
      try { mtimeMs = Number(fs.statSync(exe).mtimeMs || 0) } catch (_) {}
      return { name: e.name, dir, exe, mtimeMs, exists: fs.existsSync(exe) }
    })
    .filter((c) => c.exists)
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
      return b.name.localeCompare(a.name, 'en', { numeric: true })
    })
  if (candidates.length > 0) {
    return { exePath: candidates[0].exe, cwd: candidates[0].dir, isStub: false, version: candidates[0].name }
  }
  // Fallback: the legacy stub at the root. We accept it but the watcher will
  // need the descendant-scan fallback to detect the real PID.
  if (fs.existsSync(stubExe)) {
    return { exePath: stubExe, cwd: runtimeDir, isStub: true, version: '' }
  }
  return null
}

// Scan all running Zalo.exe processes for one whose CommandLine contains our
// unique `--appdata-id=<cloneId>`. Returns the most-recently-started match.
// Used as a fallback when the directly-spawned PID dies (Squirrel stub) but
// the real Zalo is still alive at a different PID.
function findZaloPidByAppdataId(cloneId) {
  const safe = String(cloneId || '').replace(/'/g, "''").replace(/[^a-z0-9_-]/gi, '')
  if (!safe) return 0
  // Avoid `$matches` — that's a PowerShell automatic variable backed by the
  // last regex capture, and assigning to it errors on some PS versions.
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'Zalo.exe'\" | Where-Object { $_.CommandLine -like '*--appdata-id=" + safe + "*' }",
    "if ($procs) {",
    "  $latest = $procs | Sort-Object CreationDate -Descending | Select-Object -First 1",
    "  if ($latest) { [Console]::Out.Write($latest.ProcessId) }",
    "}",
  ].join('; ')
  const rs = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', psScript,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  if (rs.error) return 0
  const pid = Number(String(rs.stdout || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : 0
}

// Poll findZaloPidByAppdataId() for up to `timeoutMs` waiting for Zalo to
// finish booting (Squirrel stub → real exe handoff can take a beat).
async function waitForZaloDescendantPid(cloneId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = findZaloPidByAppdataId(cloneId)
    if (pid > 0) {
      const exe = getProcessExecutablePath(pid)
      if (exe) return { pid, exe }
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return { pid: 0, exe: '' }
}

function requestFocusForPid(pid, logger = () => {}, context = {}) {
  const safePid = Number(pid)
  if (!Number.isInteger(safePid) || safePid <= 0) return false

  // Tray-aware focus: Zalo PC có thể minimize/hide vào tray sau lần đầu khởi
  // động; lúc đó `Process.MainWindowHandle` trả về 0 (không có visible window
  // top-level), nên `Get-Process | MainWindowHandle` không đủ. Phải enumerate
  // toàn bộ top-level window theo PID (kể cả ẩn / minimize / off-screen) và
  // force-show. Cũng phải scan các descendant PID cùng cây vì Zalo helper
  // processes giữ window thật khi launched qua Squirrel stub.
  const scriptBody =
    '$ErrorActionPreference = "SilentlyContinue"' + "\n" +
    'Add-Type @"' + "\n" +
    'using System;' + "\n" +
    'using System.Runtime.InteropServices;' + "\n" +
    'using System.Text;' + "\n" +
    'using System.Collections.Generic;' + "\n" +
    'public class WinApi {' + "\n" +
    '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);' + "\n" +
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);' + "\n" +
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' + "\n" +
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);' + "\n" +
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);' + "\n" +
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' + "\n" +
    '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);' + "\n" +
    '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);' + "\n" +
    '  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);' + "\n" +
    '  public static List<IntPtr> FindWindows(HashSet<uint> pids) {' + "\n" +
    '    List<IntPtr> result = new List<IntPtr>();' + "\n" +
    '    EnumWindows((h, l) => {' + "\n" +
    '      uint procId = 0;' + "\n" +
    '      GetWindowThreadProcessId(h, out procId);' + "\n" +
    '      if (pids.Contains(procId) && GetWindowTextLength(h) > 0 && GetParent(h) == IntPtr.Zero) {' + "\n" +
    '        result.Add(h);' + "\n" +
    '      }' + "\n" +
    '      return true;' + "\n" +
    '    }, IntPtr.Zero);' + "\n" +
    '    return result;' + "\n" +
    '  }' + "\n" +
    '}' + "\n" +
    '"@' + "\n" +
    '$rootPid = ' + safePid + "\n" +
    'function Get-DescendantPids($root) {' + "\n" +
    '  $set = New-Object System.Collections.Generic.HashSet[uint32]' + "\n" +
    '  [void]$set.Add([uint32]$root)' + "\n" +
    '  try {' + "\n" +
    '    $cim = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue' + "\n" +
    '    $changed = $true' + "\n" +
    '    while ($changed) {' + "\n" +
    '      $changed = $false' + "\n" +
    '      foreach ($proc in $cim) {' + "\n" +
    '        if ($set.Contains([uint32]$proc.ParentProcessId) -and -not $set.Contains([uint32]$proc.ProcessId)) {' + "\n" +
    '          if ($set.Add([uint32]$proc.ProcessId)) { $changed = $true }' + "\n" +
    '        }' + "\n" +
    '      }' + "\n" +
    '    }' + "\n" +
    '  } catch {}' + "\n" +
    '  return $set' + "\n" +
    '}' + "\n" +
    '$deadline = (Get-Date).AddSeconds(15)' + "\n" +
    '$shown = $false' + "\n" +
    'while ((Get-Date) -lt $deadline) {' + "\n" +
    '  $pids = Get-DescendantPids -root $rootPid' + "\n" +
    '  $wins = [WinApi]::FindWindows($pids)' + "\n" +
    '  foreach ($h in $wins) {' + "\n" +
    '    [void][WinApi]::ShowWindowAsync($h, 9)' + "\n" +
    '    [void][WinApi]::ShowWindowAsync($h, 5)' + "\n" +
    '    [void][WinApi]::BringWindowToTop($h)' + "\n" +
    '    [void][WinApi]::SetForegroundWindow($h)' + "\n" +
    '    $shown = $true' + "\n" +
    '  }' + "\n" +
    '  if ($shown) { break }' + "\n" +
    '  Start-Sleep -Milliseconds 200' + "\n" +
    '}' + "\n"

  let scriptPath = ''
  try {
    const tmpDir = path.join(os.tmpdir(), 'zalomask-focus')
    fs.mkdirSync(tmpDir, { recursive: true })
    scriptPath = path.join(tmpDir, `focus-${safePid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`)
    fs.writeFileSync(scriptPath, scriptBody, 'utf8')
  } catch (error) {
    logger('pc-profile-focus-script-write-failed', {
      pid: safePid,
      message: error && error.message ? error.message : String(error),
      ...context,
    })
    return false
  }

  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    // Best-effort cleanup after the script has had time to finish (~20s).
    setTimeout(() => { try { fs.unlinkSync(scriptPath) } catch (_) {} }, 25000).unref()
    logger('pc-profile-focus-requested', { pid: safePid, ...context })
    return true
  } catch (error) {
    try { fs.unlinkSync(scriptPath) } catch (_) {}
    logger('pc-profile-focus-request-failed', {
      pid: safePid,
      message: error && error.message ? error.message : String(error),
      ...context,
    })
    return false
  }
}

async function getPcProfileRuntimeState(profileName, opts = {}) {
  const log = opts.logger || (() => {})
  // Must match launchPcProfile / ensureAsarPatched: after app restart, cache
  // from resolveZaloRuntimeDir() alone can still point at the bundled tree
  // while Zalo is running from a copied runtime under LocalAppData.
  const runtimeDir = await pickRuntimeDirAsync(log)
  // Accept any Zalo.exe sitting somewhere under our runtime root — the user
  // may be running either the top-level stub or the inner versioned exe.
  // Comparing to a single expectedExe broke when we switched to launching
  // the inner exe directly (the recorded PID is the inner one, but the old
  // check insisted on the stub path → pid-reused-different-exe false alarm).
  const runtimeRootResolved = runtimeDir ? path.resolve(runtimeDir).toLowerCase() : ''
  let userRuntimeResolved = ''
  try {
    const ur = path.join(getUserRuntimeRoot(), RUNTIME_DIR_NAME)
    if (ur && fs.existsSync(ur)) userRuntimeResolved = path.resolve(ur).toLowerCase()
  } catch (_) {}
  const sep = path.sep.toLowerCase()

  const pidInfo = readProfilePid(profileName, opts)
  if (!pidInfo.ok || !pidInfo.pid) {
    return { ok: true, running: false, pid: 0, reason: 'pid-missing' }
  }

  const runningExe = getProcessExecutablePath(pidInfo.pid)
  if (!runningExe) {
    try { if (fs.existsSync(pidInfo.pidFilePath)) fs.unlinkSync(pidInfo.pidFilePath) } catch {}
    return { ok: true, running: false, pid: pidInfo.pid, reason: 'process-not-found' }
  }

  const runningResolved = path.resolve(runningExe).toLowerCase()
  const baseName = path.basename(runningResolved)
  const isZaloExe = baseName === 'zalo.exe'
  const underPicked =
    !!(runtimeRootResolved && runningResolved.startsWith(runtimeRootResolved + sep))
  const underUserCopy =
    !!(userRuntimeResolved && runningResolved.startsWith(userRuntimeResolved + sep))
  const insideRuntime = underPicked || underUserCopy
  if (!isZaloExe) {
    return {
      ok: false,
      running: false,
      pid: pidInfo.pid,
      reason: 'pid-reused-different-exe',
      executablePath: runningExe,
    }
  }
  if ((runtimeRootResolved || userRuntimeResolved) && !insideRuntime) {
    return {
      ok: false,
      running: false,
      pid: pidInfo.pid,
      reason: 'pid-reused-different-exe',
      executablePath: runningExe,
    }
  }

  return { ok: true, running: true, pid: pidInfo.pid, reason: 'running', executablePath: runningExe }
}

async function terminatePcProfile(profileName, opts = {}) {
  const logger = opts.logger || (() => {})
  const pidInfo = readProfilePid(profileName, opts)
  const runtimeState = await getPcProfileRuntimeState(profileName, opts)
  if (!runtimeState.ok) {
    await stopProxyBridgeForProfile(profileName, logger)
    return { ok: false, killed: false, reason: runtimeState.reason, pid: runtimeState.pid || 0, executablePath: runtimeState.executablePath }
  }
  if (!runtimeState.running) {
    await stopProxyBridgeForProfile(profileName, logger)
    return { ok: true, killed: false, reason: runtimeState.reason, pid: runtimeState.pid || 0 }
  }

  // Try a graceful taskkill (no /F) first so Chromium can flush its SQLite WAL
  // (Network/Cookies-wal → Network/Cookies merge) and LevelDB log compaction.
  // Wait up to ~3.5s for the process to exit; escalate to /F only if it survives.
  // Without this step, force-killing mid-write often leaves Cookies-wal with
  // uncommitted transactions → cookies look corrupted on the destination.
  let gracefulOutput = ''
  let gracefulStatus = -1
  try {
    const graceful = spawnSync('taskkill.exe', ['/PID', String(runtimeState.pid), '/T'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    })
    gracefulStatus = typeof graceful.status === 'number' ? graceful.status : -1
    gracefulOutput = String(graceful.stdout || graceful.stderr || '').trim()
  } catch (_) {
    gracefulStatus = -1
  }
  // Poll the runtime state for up to 3.5s — exit ASAP once the process is gone.
  const POLL_BUDGET_MS = 3500
  const POLL_STEP_MS = 250
  const pollStart = Date.now()
  let stillRunning = true
  while (Date.now() - pollStart < POLL_BUDGET_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS))
    const live = await getPcProfileRuntimeState(profileName, opts)
    if (!live.ok || !live.running) {
      stillRunning = false
      break
    }
  }

  if (!stillRunning) {
    try { if (fs.existsSync(pidInfo.pidFilePath)) fs.unlinkSync(pidInfo.pidFilePath) } catch {}
    await stopProxyBridgeForProfile(profileName, logger)
    logger('pc-profile-terminate-graceful', { profileName, pid: runtimeState.pid, gracefulStatus, gracefulOutput })
    // Extra short pause so the OS finishes flushing the file handles to disk.
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { ok: true, killed: true, reason: 'terminated-graceful', pid: runtimeState.pid, output: gracefulOutput }
  }

  // Graceful did not work — escalate to force kill.
  const killRs = spawnSync('taskkill.exe', ['/PID', String(runtimeState.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  })
  const output = String(killRs.stdout || killRs.stderr || '').trim()
  if (killRs.error) {
    return { ok: false, killed: false, reason: killRs.error.message || 'taskkill-error', pid: runtimeState.pid, output }
  }
  if (killRs.status !== 0) {
    if (/not found|no running instance|cannot find/i.test(output)) {
      try { if (fs.existsSync(pidInfo.pidFilePath)) fs.unlinkSync(pidInfo.pidFilePath) } catch {}
      await stopProxyBridgeForProfile(profileName, logger)
      return { ok: true, killed: false, reason: 'process-not-found', pid: runtimeState.pid, output }
    }
    return { ok: false, killed: false, reason: 'taskkill-failed', pid: runtimeState.pid, output }
  }

  try { if (fs.existsSync(pidInfo.pidFilePath)) fs.unlinkSync(pidInfo.pidFilePath) } catch {}
  await stopProxyBridgeForProfile(profileName, logger)
  // Brief settle so the OS finishes flushing Cookies-wal/-shm sidecars.
  await new Promise((resolve) => setTimeout(resolve, 500))
  logger('pc-profile-terminate-force', { profileName, pid: runtimeState.pid, output })
  return { ok: true, killed: true, reason: 'terminated', pid: runtimeState.pid, output }
}

/** Launch a PC mode profile. Returns { ok, message?, pid? }. */
async function launchPcProfile(profileName, opts = {}) {
  const meta = opts.meta || {}
  const logger = opts.logger || (() => {})

  const runtimeDir = await pickRuntimeDirAsync(logger)
  if (!runtimeDir) {
    const st = buildRuntimeStatus(null)
    return { ok: false, message: st.message || 'Không chuẩn bị được runtime Zalo PC.' }
  }
  // Prefer the versioned inner exe (e.g. zalo-runtime/Zalo-26.4.10/Zalo.exe).
  // The top-level Zalo.exe is a Squirrel stub that exits with code 0 right
  // after spawning the real exe, which trips our fast-exit watchdog.
  const resolvedExe = resolveBundledZaloExe(runtimeDir)
  if (!resolvedExe) {
    return { ok: false, message: 'Không tìm thấy Zalo.exe trong runtime bundle.' }
  }
  const exe = resolvedExe.exePath
  const exeCwd = resolvedExe.cwd || runtimeDir
  const exeIsStub = !!resolvedExe.isStub
  try {
    logger('pc-profile-resolve-exe', {
      profileName,
      exe,
      cwd: exeCwd,
      isStub: exeIsStub,
      version: resolvedExe.version || '',
    })
  } catch (_) {}

  const cloneId = meta.cloneId || cloneIdFor(profileName)
  const args = []
  // Required for clone-main-shim.js to activate (it checks argv early).
  // Also keeps backwards compatibility with older ZaX/ZaloMulti-style flags.
  args.push(`--appdata-id=${cloneId}`)
  try {
    logger('pc-profile-arg-appdata-id', { profileName, cloneId, arg: `--appdata-id=${cloneId}` })
  } catch (_) {}

  const desktopEnv = resolveProfileDesktopEnv(profileName, opts)
  const runtimeState = await getPcProfileRuntimeState(profileName, opts)
  if (!runtimeState.ok) {
    return { ok: false, message: `PID của profile đang trỏ tới process khác: ${runtimeState.executablePath || runtimeState.reason}` }
  }
  if (runtimeState.running) {
    requestFocusForPid(runtimeState.pid, logger, { profileName, source: 'already-running' })
    logger('pc-profile-launch-skip-already-running', { profileName, pid: runtimeState.pid })
    return { ok: true, pid: runtimeState.pid, cloneId, profileRoot: desktopEnv.profileRoot, alreadyRunning: true }
  }

  // Proxy
  const proxyArg = buildPcProxyArg(meta.proxy || {})
  if (!proxyArg.ok) return { ok: false, message: proxyArg.message }
  await stopProxyBridgeForProfile(profileName, logger)
  let proxyRoute = {
    mode: proxyArg.mode || 'direct',
    serverArg: proxyArg.value || '--no-proxy-server',
  }
  let proxyFallback = null
  if (proxyArg.needsBridge) {
    // Resilient launch: if the local proxy-auth bridge fails to start (port
    // exhausted / firewall blocks self-test / upstream slow), don't abort the
    // launch. Try URL-based auth (--proxy-server=http://user:pass@host:port);
    // if that also can't be built (only HTTP proxies support it), fall back
    // to no-proxy and warn the user. The intent is "always open Zalo" —
    // network problems should NEVER prevent the window from showing.
    let bridge = null
    try {
      bridge = await ensureProxyBridge(profileName, meta.proxy || {}, logger)
    } catch (bridgeError) {
      logger('pc-profile-proxy-bridge-failed', {
        profileName,
        message: bridgeError?.message || 'unknown',
      })
    }

    if (bridge) {
      const routeArg = `--proxy-server=http://${bridge.host}:${bridge.port}`
      args.push(routeArg)
      proxyRoute = {
        mode: 'bridge',
        serverArg: routeArg,
        bridgeHost: bridge.host,
        bridgePort: bridge.port,
      }
    } else {
      // Bridge unavailable → try URL-auth fallback (only HTTP/HTTPS).
      const protocol = String(meta.proxy?.protocol || 'HTTP').toUpperCase()
      if (protocol !== 'SOCKS5' && meta.proxy?.username) {
        const proto = protocol === 'HTTPS' ? 'https' : 'http'
        const user = encodeURIComponent(String(meta.proxy.username || ''))
        const pass = encodeURIComponent(String(meta.proxy.password || ''))
        const routeArg = `--proxy-server=${proto}://${user}:${pass}@${meta.proxy.host}:${meta.proxy.port}`
        args.push(routeArg)
        proxyRoute = { mode: 'url-auth-fallback', serverArg: routeArg }
        proxyFallback = { mode: 'url-auth', reason: 'bridge-failed' }
        logger('pc-profile-proxy-fallback-url-auth', {
          profileName,
          host: meta.proxy.host,
          port: Number(meta.proxy.port || 0),
        })
      } else {
        // No safe fallback for SOCKS5+auth or no-creds bridge fail → no proxy.
        args.push('--no-proxy-server')
        proxyRoute = { mode: 'no-proxy-fallback', serverArg: '--no-proxy-server' }
        proxyFallback = { mode: 'no-proxy', reason: 'bridge-failed' }
        logger('pc-profile-proxy-fallback-no-proxy', { profileName })
      }
    }
  } else {
    args.push(proxyArg.value)
  }

  // Proxies don't carry QUIC/HTTP3 (UDP). Some Zalo builds attempt QUIC first
  // and report "offline" even when TCP works through proxy. Disable it when a
  // proxy is configured.
  if (meta.proxy && meta.proxy.enabled) {
    args.push('--disable-quic')
    args.push('--disable-features=UseDnsHttpsSvcb,UseHttp3')
  }
  logger('pc-profile-proxy-route', {
    profileName,
    mode: proxyRoute.mode,
    serverArg: proxyRoute.serverArg,
    bridgeHost: proxyRoute.bridgeHost || '',
    bridgePort: Number(proxyRoute.bridgePort || 0),
  })

  // Privacy flags propagated via env so privacy-shim inside Zalo can read them.
  const privacy = meta.privacy || {}

  // Write per-profile privacy settings file so the shim can pick up live changes
  // and has the correct state from first load (shim reads file, not env vars).
  try {
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    const privDir = path.join(programData, 'ZaloMask', 'privacy')
    fs.mkdirSync(privDir, { recursive: true })
    fs.writeFileSync(
      path.join(privDir, profileName + '.json'),
      JSON.stringify({
        hideTyping: !!privacy.hideTyping,
        hideSeen: !!privacy.hideSeen,
        hideReceived: !!privacy.hideReceived,
      }),
      'utf8'
    )
  } catch (_) {}

  const env = {
    ...process.env,
    ZALOMASK_CLONE_ID: cloneId,
    ZALOMASK_PROFILE_NAME: profileName,
    ZALOMASK_HIDE_TYPING: privacy.hideTyping ? '1' : '0',
    ZALOMASK_HIDE_SEEN: privacy.hideSeen ? '1' : '0',
    ZALOMASK_HIDE_RECEIVED: privacy.hideReceived ? '1' : '0',
    USERPROFILE: desktopEnv.profileRoot,
    APPDATA: desktopEnv.roamingPath,
    LOCALAPPDATA: desktopEnv.localPath,
  }

  try {
    const child = spawn(exe, args, {
      cwd: exeCwd,
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    const spawnedPid = Number(child.pid || 0)
    try { fs.writeFileSync(desktopEnv.pidFilePath, String(spawnedPid || ''), 'ascii') } catch {}

    // Capture fast-exit diagnostics (exit code). Some proxy arguments cause
    // Zalo.exe to terminate instantly; we want the code in logs.
    let exited = false
    let exitCode = null
    let exitSignal = null
    try {
      child.once('exit', (code, signal) => {
        exited = true
        exitCode = typeof code === 'number' ? code : null
        exitSignal = signal || null
      })
      child.once('error', (err) => {
        exited = true
        exitCode = -1
        exitSignal = null
        try {
          logger('pc-profile-spawn-error', { profileName, cloneId, pid: spawnedPid, message: err?.message || 'spawn error', args })
        } catch (_) {}
      })
    } catch (_) {}

    // Verify the process actually stayed up. spawn() can return a pid even if
    // the child exits immediately (missing runtime deps / policy blocks / bad args).
    await new Promise((resolve) => setTimeout(resolve, 650))
    let livePid = spawnedPid
    let runningExe = spawnedPid > 0 ? getProcessExecutablePath(spawnedPid) : ''
    let resolvedVia = runningExe ? 'spawned-pid' : ''

    // If the spawned PID is dead, the most likely cause is the Squirrel-style
    // top-level Zalo.exe stub: it spawns the real exe and exits with code 0
    // immediately. Search for the real Zalo.exe by our unique --appdata-id.
    if (!livePid || !runningExe) {
      const found = await waitForZaloDescendantPid(cloneId, 5000)
      if (found.pid > 0 && found.exe) {
        livePid = found.pid
        runningExe = found.exe
        resolvedVia = 'descendant-scan'
        // Update PID file with the real (descendant) PID so terminate works.
        try { fs.writeFileSync(desktopEnv.pidFilePath, String(livePid), 'ascii') } catch {}
        logger('pc-profile-real-pid-resolved', {
          profileName,
          cloneId,
          spawnedPid,
          livePid,
          stubExitCode: exitCode,
          isStub: exeIsStub,
        })
      }
    }

    if (!livePid || !runningExe) {
      try { if (fs.existsSync(desktopEnv.pidFilePath)) fs.unlinkSync(desktopEnv.pidFilePath) } catch {}
      await stopProxyBridgeForProfile(profileName, logger)
      logger('pc-profile-exited-immediately', {
        profileName,
        cloneId,
        pid: spawnedPid,
        args,
        exited,
        exitCode,
        exitSignal,
        profileRoot: desktopEnv.profileRoot,
        isStub: exeIsStub,
      })
      const codeHint = (exitCode !== null && exitCode !== undefined) ? ` (exitCode=${exitCode})` : ''
      return { ok: false, message: 'Zalo.exe khởi chạy nhưng thoát ngay (không giữ được process).' + codeHint + ' Thử lại hoặc kiểm tra runtime/proxy.' }
    }

    requestFocusForPid(livePid, logger, { profileName, source: 'fresh-launch' })
    logger('pc-profile-launched', { profileName, cloneId, pid: livePid, spawnedPid, resolvedVia, profileRoot: desktopEnv.profileRoot })
    return { ok: true, pid: livePid, cloneId, profileRoot: desktopEnv.profileRoot, proxyFallback }
  } catch (e) {
    return { ok: false, message: e.message }
  }
}

/** Build runtime diagnostics after runtimeDir resolved (writable bundle or user copy). */
function buildRuntimeStatus(runtimeDir) {
  if (!runtimeDir) {
    let message = 'Runtime bundle chưa có. Chạy scripts/setup-zalo-runtime.ps1 trước khi build.'
    if (app.isPackaged) {
      message =
        'Thiếu Zalo PC trong bản cài (installer không chứa đủ runtime). ' +
        'Tải lại bản ZaloMask-Setup từ GitHub Release hoặc trang chủ (bản build CI đã đóng gói runtime). ' +
        'Nếu tự build: chạy scripts/setup-zalo-runtime.ps1 rồi npm run dist.'
    }
    if (lastRuntimePickFailure && lastRuntimePickFailure.kind === 'user-copy-failed') {
      const ud = String(lastRuntimePickFailure.userDest || '')
      const src = String(lastRuntimePickFailure.source || '')
      const ce = String(lastRuntimePickFailure.copyError || '').slice(0, 280)
      message =
        'Không sao chép được Zalo PC vào thư mục có thể ghi (thường do đường dẫn Program Files chỉ đọc). ' +
        'Đóng Zalo + ZaloMask, xóa thư mục \"' + ud + '\" nếu còn sót bản copy lỗi, rồi mở lại. ' +
        (src ? '(Mã: ' + src + ') ' : '') +
        (ce ? ce : '')
    }
    return {
      ok: false,
      message,
      runtimeDir: null,
      exePath: null,
      exeExists: false,
      asarPath: null,
      asarExists: false,
      patched: false,
      patchVersion: PATCH_VERSION,
    }
  }
  let resolved = resolveBundledZaloExe(runtimeDir)
  let exe = resolved ? resolved.exePath : path.join(runtimeDir, 'Zalo.exe')
  let asar = resolveBundledZaloAsarInDir(runtimeDir)
  const exeExists = fs.existsSync(exe)
  let asarExists = !!asar && fs.existsSync(asar)

  const patched = !!(asar && asarExists && isPatchApplied(asar))
  return {
    ok: exeExists,
    runtimeDir,
    exePath: exe,
    exeExists,
    exeIsStub: !!(resolved && resolved.isStub),
    exeVersion: (resolved && resolved.version) || '',
    asarPath: asar,
    asarExists,
    patched,
    patchVersion: PATCH_VERSION,
    message: !exeExists
      ? 'Thiếu Zalo.exe trong runtime bundle.'
      : 'Runtime OK',
  }
}

/** Diagnostic: report runtime status (used by app health UI). Async — copies runtime off Program Files when needed. */
async function getRuntimeStatus() {
  const runtimeDir = await pickRuntimeDirAsync(() => {})
  return buildRuntimeStatus(runtimeDir)
}

module.exports = {
  resolveZaloRuntimeDir,
  resolveBundledZaloAsar,
  ensureAsarPatched,
  launchPcProfile,
  getPcProfileRuntimeState,
  terminatePcProfile,
  getActiveProxyBridge,
  stopProxyBridgeForProfile,
  getRuntimeStatus,
  cloneIdFor,
  PATCH_VERSION,
}
