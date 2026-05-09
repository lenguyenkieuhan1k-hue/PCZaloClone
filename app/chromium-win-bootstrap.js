'use strict'

/**
 * Phải gọi ngay sau `require('electron')`, trước `app.isPackaged` / `app.whenReady`.
 *
 * Trên Windows, cache Chromium mặc định đôi khi bị AV hoặc lock file → log
 * `cache_util_win` / `gpu_disk_cache failed` và UI renderer đơ khi gõ trong modal.
 *
 * Không xóa module này — `npm run predist` chạy assert-chromium-bootstrap.js .
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

function applyEarlyChromiumSwitches(app) {
  try {
    const cacheDir = path.join(os.tmpdir(), 'ZaloMask', 'chromium-cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
  } catch (_) {}
  app.commandLine.appendSwitch('disable-gpu-disk-cache')
  try {
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  } catch (_) {}
  // Máy Win khác nhau: renderer đôi bị throttle / occlude sớm → gõ trong modal tưởng "đơ".
  if (process.platform === 'win32') {
    try {
      app.commandLine.appendSwitch('disable-renderer-backgrounding')
      app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
    } catch (_) {}
  }
}

module.exports = { applyEarlyChromiumSwitches }
