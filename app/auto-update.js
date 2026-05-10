'use strict'

/* ZaloMask auto-updater
 *
 * 1) Nếu config.json có `updates.manifestUrl` (HTTPS JSON) → lấy bản mới + link
 *    tải từ web/CDN của bạn, không cần GitHub Releases.
 * 2) Ngược lại → GitHub Releases API (`github.owner` + `github.repo`).
 * So sánh semver; IPC check/download/install. Chưa xác minh chữ ký file.
 *
 * Why not electron-updater? The dep is pinned to v4 in package.json and
 * upgrading to v6 (required for Electron 35) is a yak-shave. A manual
 * implementation is ~150 lines and gives us full control over UX text. */

const fs = require('fs')
const path = require('path')
const https = require('https')
const os = require('os')
const { app, BrowserWindow, shell, ipcMain } = require('electron')
const { spawn } = require('child_process')

const CHECK_INTERVAL_MS = 60 * 60 * 1000   // re-check every hour
const USER_AGENT = 'ZaloMask-Updater'
const CONFIG_GITHUB_KEY = 'github'

let cachedRelease = null              // GitHub release object when using GitHub provider
/** @type {{ version: string, installerUrl: string, releaseNotes: string, publishedAt: string, assetName: string } | null} */
let cachedManifest = null             // custom manifest when using updates.manifestUrl
let updateChannel = ''               // '' | 'manifest' | 'github'
let downloadInfo = null               // { localPath, version }
let downloading = false
let lastError = null

function broadcastUpdateAvailable(payload) {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue
    try {
      win.webContents.send('update-available', payload)
    } catch (_) {}
  }
}

/* ---------- Config ---------- */

function getConfig(rootConfigPath) {
  try {
    const text = fs.readFileSync(rootConfigPath, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function getGithubConfig(rootConfigPath) {
  const cfg = getConfig(rootConfigPath)
  const gh = cfg[CONFIG_GITHUB_KEY] || {}
  return {
    owner: String(gh.owner || '').trim(),
    repo: String(gh.repo || '').trim(),
    prerelease: Boolean(gh.prerelease)
  }
}

function getManifestUrl(rootConfigPath) {
  const cfg = getConfig(rootConfigPath)
  const u = cfg.updates && typeof cfg.updates === 'object' ? cfg.updates.manifestUrl : ''
  return String(u || '').trim()
}

/* ---------- HTTP ---------- */

function httpsGetJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, Object.assign({
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json'
      }
    }, options || {}), (res) => {
      const chunks = []
      // GitHub redirects on some endpoints; follow once.
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (!loc) return reject(new Error('redirect without location'))
        httpsGetJson(loc, options).then(resolve, reject)
        res.resume()
        return
      }
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
        }
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
  })
}

/** JSON từ URL tùy ý (manifest cập nhật), không dùng header GitHub API. */
function httpsGetGenericJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      },
    }, (res) => {
      const chunks = []
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (!loc) return reject(new Error('redirect without location'))
        httpsGetGenericJson(loc).then(resolve, reject)
        res.resume()
        return
      }
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
  })
}

function httpsDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (!loc) return reject(new Error('redirect without location'))
        res.resume()
        httpsDownload(loc, destPath, onProgress).then(resolve, reject)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      const file = fs.createWriteStream(destPath)
      res.on('data', (chunk) => {
        received += chunk.length
        try { onProgress && onProgress({ received, total, percent: total ? received / total : 0 }) } catch (_) {}
      })
      res.pipe(file)
      file.on('finish', () => file.close((err) => err ? reject(err) : resolve(destPath)))
      file.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')))
  })
}

/* ---------- Semver ---------- */

function parseVersion(v) {
  const cleaned = String(v || '').trim().replace(/^v/i, '')
  const parts = cleaned.split(/[.\-+]/)
  return {
    major: Number(parts[0]) || 0,
    minor: Number(parts[1]) || 0,
    patch: Number(parts[2]) || 0,
    raw: cleaned
  }
}

function isNewer(remote, local) {
  const r = parseVersion(remote), l = parseVersion(local)
  if (r.major !== l.major) return r.major > l.major
  if (r.minor !== l.minor) return r.minor > l.minor
  return r.patch > l.patch
}

/* ---------- GitHub Release fetch ---------- */

async function fetchLatestRelease(owner, repo, includePrerelease) {
  if (!owner || !repo) throw new Error('Chưa cấu hình GitHub owner/repo trong config.json')
  if (includePrerelease) {
    const list = await httpsGetJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`)
    if (!Array.isArray(list) || !list.length) throw new Error('No releases')
    return list[0]
  }
  return httpsGetJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
}

function pickInstallerAsset(release) {
  if (!release || !Array.isArray(release.assets)) return null
  // Prefer NSIS installer matching ZaloMask-Setup-*.exe
  for (const a of release.assets) {
    if (/^ZaloMask-Setup-.*\.exe$/i.test(a.name)) return a
  }
  for (const a of release.assets) {
    if (/\.exe$/i.test(a.name)) return a
  }
  return null
}

function installerNameFromUrl(installerUrl) {
  try {
    const p = new URL(installerUrl).pathname || ''
    const base = path.basename(p)
    return base && /\.exe$/i.test(base) ? base : 'ZaloMask-Setup.exe'
  } catch (_) {
    return 'ZaloMask-Setup.exe'
  }
}

function validateHttpsUrl(u) {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' ? x.href : ''
  } catch (_) {
    return ''
  }
}

/**
 * Manifest mẫu (host tĩnh hoặc API của bạn):
 * { "version": "26.3.41", "installerUrl": "https://cdn.../ZaloMask-Setup-26.3.41.exe",
 *   "releaseNotes": "...", "publishedAt": "ISO" }
 */
async function checkForUpdatesFromManifest(manifestUrl, localVersion) {
  const body = await httpsGetGenericJson(manifestUrl)
  const remoteVersion = parseVersion(body.version || body.tag || '0.0.0').raw
  const installerUrl = validateHttpsUrl(String(body.installerUrl || body.url || '').trim())
  if (!installerUrl) {
    throw new Error('Manifest thiếu installerUrl hợp lệ (HTTPS).')
  }
  const hasUpdate = isNewer(remoteVersion, localVersion)
  cachedRelease = null
  if (!hasUpdate) {
    cachedManifest = null
    updateChannel = ''
  } else {
    cachedManifest = {
      version: remoteVersion,
      installerUrl,
      releaseNotes: String(body.releaseNotes || body.notes || body.body || ''),
      publishedAt: String(body.publishedAt || body.published_at || ''),
      assetName: installerNameFromUrl(installerUrl),
    }
    updateChannel = 'manifest'
  }
  return {
    ok: true,
    hasUpdate,
    localVersion,
    remoteVersion,
    releaseUrl: installerUrl,
    releaseNotes: String(body.releaseNotes || body.notes || body.body || ''),
    publishedAt: (body.publishedAt || body.published_at) || null,
    assetName: hasUpdate ? installerNameFromUrl(installerUrl) : null,
    updateChannel: hasUpdate ? 'manifest' : '',
  }
}

/* ---------- Public surface ---------- */

async function checkForUpdates(opts) {
  opts = opts || {}
  const rootConfigPath = opts.configPath
  if (!rootConfigPath) throw new Error('checkForUpdates: configPath bắt buộc')
  const localVersion = app.getVersion()
  cachedRelease = null
  cachedManifest = null
  updateChannel = ''

  const manifestUrl = getManifestUrl(rootConfigPath)
  if (manifestUrl) {
    if (!/^https:\/\//i.test(manifestUrl)) {
      lastError = 'updates.manifestUrl phải là HTTPS.'
      return { ok: false, hasUpdate: false, localVersion, message: lastError }
    }
    try {
      return await checkForUpdatesFromManifest(manifestUrl, localVersion)
    } catch (error) {
      lastError = error.message || String(error)
      return { ok: false, hasUpdate: false, localVersion, message: lastError }
    }
  }

  const gh = getGithubConfig(rootConfigPath)
  try {
    const release = await fetchLatestRelease(gh.owner, gh.repo, gh.prerelease)
    cachedRelease = release
    updateChannel = 'github'
    const remoteVersion = parseVersion(release.tag_name || release.name || '0.0.0').raw
    const hasUpdate = isNewer(remoteVersion, localVersion)
    return {
      ok: true,
      hasUpdate,
      localVersion,
      remoteVersion,
      releaseUrl: release.html_url,
      releaseNotes: release.body || '',
      publishedAt: release.published_at,
      assetName: hasUpdate ? (pickInstallerAsset(release) || {}).name || null : null,
      updateChannel: 'github',
    }
  } catch (error) {
    lastError = error.message || String(error)
    return { ok: false, hasUpdate: false, localVersion, message: lastError }
  }
}

async function downloadUpdate(opts) {
  opts = opts || {}
  if (downloading) return { ok: false, message: 'Đang tải, vui lòng đợi.' }
  if (!cachedRelease && !cachedManifest) {
    const checked = await checkForUpdates({ configPath: opts.configPath })
    if (!checked.ok || !checked.hasUpdate) {
      return { ok: false, message: 'Không có bản cập nhật để tải.' }
    }
  }

  let downloadUrl = ''
  let fileName = 'ZaloMask-Setup.exe'
  let versionStr = ''

  if (cachedManifest && updateChannel === 'manifest') {
    downloadUrl = cachedManifest.installerUrl
    fileName = cachedManifest.assetName || installerNameFromUrl(downloadUrl)
    versionStr = cachedManifest.version
  } else {
    const asset = pickInstallerAsset(cachedRelease)
    if (!asset) return { ok: false, message: 'Release không có file installer .exe.' }
    downloadUrl = asset.browser_download_url
    fileName = asset.name
    versionStr = parseVersion(cachedRelease.tag_name || '').raw
  }

  if (!downloadUrl) return { ok: false, message: 'Không có URL tải installer.' }

  downloading = true
  try {
    const tmpDir = path.join(os.tmpdir(), 'zalomask-update')
    fs.mkdirSync(tmpDir, { recursive: true })
    const localPath = path.join(tmpDir, fileName)
    const onProgress = (info) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('update-download-progress', {
          percent: info.percent,
          received: info.received,
          total: info.total
        })
      }
    }
    await httpsDownload(downloadUrl, localPath, onProgress)
    downloadInfo = {
      localPath,
      version: versionStr,
      assetName: fileName
    }
    return { ok: true, localPath, version: downloadInfo.version }
  } catch (error) {
    lastError = error.message
    return { ok: false, message: error.message }
  } finally {
    downloading = false
  }
}

function installAndQuit() {
  if (!downloadInfo || !downloadInfo.localPath) {
    return { ok: false, message: 'Chưa có file installer. Tải về trước khi cài.' }
  }
  if (!fs.existsSync(downloadInfo.localPath)) {
    return { ok: false, message: 'File installer đã biến mất. Tải lại.' }
  }
  // Spawn detached so installer survives app quit. /S = silent, but NSIS
  // oneClick=false means user gets the wizard. Pass /S to skip wizard if
  // user wants silent.
  try {
    const child = spawn(downloadInfo.localPath, [], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    setTimeout(() => app.quit(), 800)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

/* ---------- IPC + scheduling ---------- */

function registerIpc(opts) {
  opts = opts || {}
  const configPath = opts.configPath
  ipcMain.handle('update-check', async () => checkForUpdates({ configPath }))
  ipcMain.handle('update-download', async () => downloadUpdate({ configPath }))
  ipcMain.handle('update-install', async () => installAndQuit())
  ipcMain.handle('update-status', async () => ({
    ok: true,
    updateChannel: updateChannel || null,
    cachedManifest: cachedManifest
      ? {
          version: cachedManifest.version,
          installerUrl: cachedManifest.installerUrl,
          publishedAt: cachedManifest.publishedAt,
        }
      : null,
    cachedRelease: cachedRelease ? {
      tagName: cachedRelease.tag_name,
      publishedAt: cachedRelease.published_at,
      htmlUrl: cachedRelease.html_url,
      body: cachedRelease.body
    } : null,
    downloadReady: Boolean(downloadInfo),
    downloading,
    lastError
  }))
}

function startBackgroundChecks(opts) {
  opts = opts || {}
  const configPath = opts.configPath
  // First check is delayed 30s after app boot to avoid stealing IO from
  // Zalo's startup and to give the Sentry/perflog systems time to settle.
  setTimeout(async () => {
    const result = await checkForUpdates({ configPath })
    if (result.ok && result.hasUpdate) {
      broadcastUpdateAvailable({
        localVersion: result.localVersion,
        remoteVersion: result.remoteVersion,
        releaseNotes: result.releaseNotes
      })
    }
  }, 30 * 1000)

  setInterval(async () => {
    const result = await checkForUpdates({ configPath })
    if (result.ok && result.hasUpdate) {
      broadcastUpdateAvailable({
        localVersion: result.localVersion,
        remoteVersion: result.remoteVersion,
        releaseNotes: result.releaseNotes
      })
    }
  }, CHECK_INTERVAL_MS)
}

module.exports = {
  registerIpc,
  startBackgroundChecks,
  checkForUpdates,
  downloadUpdate,
  installAndQuit,
  // exported for unit tests
  _internal: { parseVersion, isNewer, pickInstallerAsset }
}
