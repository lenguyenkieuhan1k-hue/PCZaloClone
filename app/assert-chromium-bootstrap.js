'use strict'

/**
 * Kiểm tra nhanh (không spawn Electron): đảm bảo bootstrap Windows + spellcheck
 * không bị mất khi merge/refactor. Chạy trong predist.
 */

const fs = require('fs')
const path = require('path')

const appDir = __dirname
const mainPath = path.join(appDir, 'main.v2.js')
const bootPath = path.join(appDir, 'chromium-win-bootstrap.js')

const main = fs.readFileSync(mainPath, 'utf8')
const boot = fs.readFileSync(bootPath, 'utf8')

const errors = []
if (!main.includes('chromium-win-bootstrap')) errors.push('main.v2.js must require chromium-win-bootstrap')
if (!main.includes('applyEarlyChromiumSwitches')) errors.push('main.v2.js must call applyEarlyChromiumSwitches(app)')
if (!boot.includes('disk-cache-dir')) errors.push('chromium-win-bootstrap.js must append disk-cache-dir')
if (!boot.includes('disable-gpu-disk-cache')) errors.push('chromium-win-bootstrap.js must append disable-gpu-disk-cache')
if (!main.includes('spellcheck: false')) errors.push('main.v2.js createMainWindow must set spellcheck: false')
if (!main.includes('backgroundThrottling: false')) errors.push('main.v2.js createMainWindow must set backgroundThrottling: false')

if (errors.length) {
  console.error('[assert-chromium-bootstrap] Failed:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('[assert-chromium-bootstrap] ok')
