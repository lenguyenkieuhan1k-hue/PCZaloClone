'use strict'

/**
 * Patch bundled app/zalo-runtime/.../app.asar before electron-builder packs extrasResources.
 * Then installed Zalo under Program Files is already patched; stamp is readable — no copy on first run.
 * Run: from repo root, after setup-zalo-runtime.ps1. predist invokes this automatically.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'app')
const RUNTIME = path.join(APP, 'zalo-runtime')
const PATCH_VERSION = 13

function resolveBundledZaloAsarInDir(dirRoot) {
  const root = String(dirRoot || '')
  if (!root || !fs.existsSync(root)) return null
  const queue = [root]
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
        } else if (e.isDirectory()) next.push(full)
      }
    }
    queue.length = 0
    queue.push(...next)
    depth += 1
  }
  const findAny = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isFile() && e.name === 'app.asar') return full
      if (e.isDirectory()) {
        const r = findAny(full)
        if (r) return r
      }
    }
    return null
  }
  try { return findAny(root) } catch { return null }
}

function main() {
  if (!fs.existsSync(path.join(RUNTIME, 'Zalo.exe'))) {
    console.warn('[patch-zalo-runtime-for-pack] skip: missing app/zalo-runtime (setup-zalo-runtime.ps1)')
    process.exit(0)
  }
  const asarPath = resolveBundledZaloAsarInDir(RUNTIME)
  if (!asarPath || !fs.existsSync(asarPath)) {
    console.error('[patch-zalo-runtime-for-pack] cannot find app.asar in app/zalo-runtime')
    process.exit(1)
  }
  const runtimeRoot = RUNTIME
  const stampPath = asarPath + '.zalomask-patched'
  if (fs.existsSync(stampPath)) {
    try {
      const st = JSON.parse(fs.readFileSync(stampPath, 'utf8').trim())
      if (Number(st.version || 0) >= PATCH_VERSION) {
        console.log('[patch-zalo-runtime-for-pack] already patched v' + st.version + ', skip.')
        process.exit(0)
      }
    } catch (_) {}
  }

  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const shimDir = path.join(programData, 'ZaloMask', 'shim')
  fs.mkdirSync(shimDir, { recursive: true })
  const privacyShimDest = path.join(shimDir, 'privacy-shim.js')
  const cloneShimDest = path.join(shimDir, 'clone-main-shim.js')
  fs.copyFileSync(path.join(APP, 'clone', 'privacy-shim.js'), privacyShimDest)
  fs.copyFileSync(path.join(APP, 'clone', 'clone-main-shim.js'), cloneShimDest)

  const extractDest = path.join(runtimeRoot, '.asar-extract-pack')
  const repackedDest = path.join(runtimeRoot, 'app-repacked-pack.asar')
  const donePath = path.join(runtimeRoot, '.asar-patch-done-pack.txt')
  const backupPath = asarPath + '.backup'
  const patcherScript = path.join(APP, 'clone', 'asar-patcher.js')

  try { fs.unlinkSync(donePath) } catch (_) {}
  try { fs.rmSync(extractDest, { recursive: true, force: true }) } catch (_) {}
  try { fs.unlinkSync(repackedDest) } catch (_) {}

  let electronExe = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electronExe)) {
    const alt = path.join(APP, 'node_modules', 'electron', 'electron.exe')
    if (fs.existsSync(alt)) electronExe = alt
  }
  if (!fs.existsSync(electronExe)) {
    console.error('[patch-zalo-runtime-for-pack] electron.exe not found. Run: cd app && npm ci')
    process.exit(1)
  }

  const args = [
    patcherScript,
    asarPath,
    backupPath,
    stampPath,
    extractDest,
    repackedDest,
    'main-dist/preload-render.js',
    privacyShimDest,
    '// [ZaloMask-privacy-v' + PATCH_VERSION + ']',
    'bootstrap.js',
    cloneShimDest,
    '// [ZaloMask-clone-v' + PATCH_VERSION + ']',
    String(PATCH_VERSION),
    donePath,
  ]

  const rs = spawnSync(electronExe, args, {
    cwd: APP,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
    stdio: 'inherit',
    timeout: 600000,
  })
  let doneMsg = ''
  try { doneMsg = fs.readFileSync(donePath, 'utf8').trim() } catch {}
  if (rs.status !== 0 || doneMsg !== 'ok') {
    console.error('[patch-zalo-runtime-for-pack] failed status=', rs.status, 'done=', doneMsg)
    process.exit(1)
  }
  console.log('[patch-zalo-runtime-for-pack] ok', asarPath)
  try { fs.rmSync(extractDest, { recursive: true, force: true }) } catch (_) {}
  try { fs.unlinkSync(repackedDest) } catch (_) {}
  try { fs.unlinkSync(donePath) } catch (_) {}
}

main()
