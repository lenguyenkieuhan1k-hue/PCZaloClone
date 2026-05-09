'use strict'

/**
 * Remove patch/Zalo backup artifacts under app/zalo-runtime before electron-builder.
 * Keeps app.asar, app.asar.unpacked/, app.asar.zalomask-patched, app-update.yml, etc.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RUNTIME = path.join(ROOT, 'app', 'zalo-runtime')

const EXTRA_BAD_FILES = new Set(['app-repacked.asar', 'app-repacked-pack.asar', '.asar-patch-done.txt', '.asar-patch-done-pack.txt'])
/** Explicit names seen from Zalo updater / patch experiments */
const APP_ASAR_BAD_RE = /^app\.asar\.(backup|directbak|hotfixbak|testbak2?|directstamp|hotfixstamp|teststamp2?)$/

function shouldUnlinkFile(name) {
  if (EXTRA_BAD_FILES.has(name)) return true
  if (APP_ASAR_BAD_RE.test(name)) return true
  if (/^app\.asar\..*bak\d*$/i.test(name)) return true
  return false
}

function walk(dir, stats) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '.asar-extract') {
        try {
          fs.rmSync(full, { recursive: true, force: true })
          stats.removedDirs += 1
        } catch (_) {}
        continue
      }
      walk(full, stats)
      continue
    }
    if (shouldUnlinkFile(e.name)) {
      try {
        fs.unlinkSync(full)
        stats.removedFiles += 1
      } catch (_) {}
    }
  }
}

function main() {
  const stats = { removedFiles: 0, removedDirs: 0 }
  if (!fs.existsSync(RUNTIME)) {
    console.warn('[clean-zalo-runtime-pack] skip: missing app/zalo-runtime')
    process.exit(0)
    return
  }
  walk(RUNTIME, stats)
  console.log(
    `[clean-zalo-runtime-pack] ${RUNTIME} removedFiles=${stats.removedFiles} removedAsarExtractDirs=${stats.removedDirs}`,
  )
}

main()
