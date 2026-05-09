'use strict'
// Runs as a child process via ELECTRON_RUN_AS_NODE=1
// Performs ALL heavy work (backup copy, extract, patch, repack) for app.asar
// without blocking Electron's main event loop.
//
// Args: asarPath backupPath stampPath extractDest repackedDest
//       preloadRelativePath shimAbsPath markerText bootstrapRelativePath
//       cloneShimAbsPath cloneMarkerText patchVersion donePath

const path = require('path')
const fs   = require('fs')

function normalizeAsarEntry(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function pickEntry(entries, preferred, fallbacks = [], testers = []) {
  const pref = normalizeAsarEntry(preferred)
  const cand = [pref, ...fallbacks.map(normalizeAsarEntry)].filter(Boolean)
  for (const c of cand) {
    if (entries.includes(c)) return c
  }
  for (const t of testers) {
    const hit = entries.find((e) => t.test(e))
    if (hit) return hit
  }
  return ''
}

async function patchAsar ({
  asarPath,
  backupPath,
  stampPath,
  extractDest,
  repackedDest,
  preloadRel,
  shimPath,
  markerText,
  bootstrapRel,
  cloneShimPath,
  cloneMarkerText,
  patchVersion,
  donePath,
} = {}) {
  const writeDone = (msg) => {
    if (!donePath) return
    try { fs.writeFileSync(donePath, msg, 'utf8') } catch {}
  }

  try {
    // Step 0: Resolve entry paths inside asar (layout may vary by Zalo version).
    const { extractAll, createPackage, listPackage } = require('@electron/asar')
    const asarEntries = (listPackage(asarPath) || []).map(normalizeAsarEntry)
    const resolvedPreloadRel = pickEntry(
      asarEntries,
      preloadRel,
      ['main-dist/preload-render.js', 'main-dist/compact-app-preload.js'],
      [/preload-render\.js$/i, /compact-app-preload\.js$/i]
    )
    const resolvedBootstrapRel = pickEntry(
      asarEntries,
      bootstrapRel,
      ['bootstrap.js', 'main-dist/bootstrap.js'],
      [/bootstrap\.js$/i]
    )
    if (!resolvedPreloadRel) {
      writeDone('error:preload entry not found in asar')
      return
    }
    if (!resolvedBootstrapRel) {
      writeDone('error:bootstrap entry not found in asar')
      return
    }

    // Step 1: Backup (runs in worker — copying 146MB here is fine, separate process)
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(asarPath, backupPath)
    }

    // Step 2: Extract. If extract fails, recover from backup and retry once.
    try {
      fs.mkdirSync(extractDest, { recursive: true })
      extractAll(asarPath, extractDest)
    } catch {
      if (!fs.existsSync(backupPath)) {
        writeDone('error:app.asar unreadable and no backup exists')
        return
      }
      try {
        fs.copyFileSync(backupPath, asarPath)
        try { fs.rmSync(extractDest, { recursive: true, force: true }) } catch {}
        fs.mkdirSync(extractDest, { recursive: true })
        extractAll(asarPath, extractDest)
      } catch {
        writeDone('error:app.asar and backup are both unreadable')
        return
      }
    }

    // Step 3: Patch the preload file
    const preloadFile = path.join(extractDest, ...resolvedPreloadRel.split('/'))
    if (!fs.existsSync(preloadFile)) {
      writeDone('error:preload not found after extract: ' + resolvedPreloadRel)
      return
    }
    const original = fs.readFileSync(preloadFile, 'utf8')
    if (!original.includes(markerText)) {
      const prefix = [
        markerText,
        ';(()=>{try{require(' + JSON.stringify(shimPath) + ')}catch(error){try{console.error("[ZaloMask] privacy shim load failed",error&&error.stack?error.stack:error)}catch{}}})();',
        ''
      ].join('\n')
      fs.writeFileSync(preloadFile, prefix + original, 'utf8')
    }

    // Step 4: Patch the bootstrap file for clone appdata routing
    const bootstrapFile = path.join(extractDest, ...resolvedBootstrapRel.split('/'))
    if (!fs.existsSync(bootstrapFile)) {
      writeDone('error:bootstrap not found after extract: ' + resolvedBootstrapRel)
      return
    }
    const bootstrapOriginal = fs.readFileSync(bootstrapFile, 'utf8')
    if (!bootstrapOriginal.includes(cloneMarkerText)) {
      const bootstrapPrefix = [
        cloneMarkerText,
        ';(()=>{try{require(' + JSON.stringify(cloneShimPath) + ')}catch(error){try{console.error("[ZaloMask] clone shim load failed",error&&error.stack?error.stack:error)}catch{}}})();',
        ''
      ].join('\n')
      fs.writeFileSync(bootstrapFile, bootstrapPrefix + bootstrapOriginal, 'utf8')
    }

    // Step 5: Repack into temp file then atomically replace
    await createPackage(extractDest, repackedDest)
    fs.copyFileSync(repackedDest, asarPath)

    // Step 6: Write stamp file with the current asar signature.
    const asarStat = fs.statSync(asarPath)
    fs.writeFileSync(stampPath, JSON.stringify({
      version: Number(patchVersion) || 1,
      patchedAt: new Date().toISOString(),
      asar: {
        size: asarStat.size,
        mtimeMs: asarStat.mtimeMs,
        mtimeIso: asarStat.mtime.toISOString()
      }
    }, null, 2), 'utf8')

    writeDone('ok')
    return { ok: true }
  } catch (err) {
    const message = 'error:' + (err && err.message ? err.message : String(err))
    writeDone(message)
    return { ok: false, message }
  }
}

async function main () {
  const args = process.argv.slice(2)
  const [asarPath, backupPath, stampPath, extractDest, repackedDest,
    preloadRel, shimPath, markerText, bootstrapRel,
    cloneShimPath, cloneMarkerText, patchVersion, donePath] = args

  const rs = await patchAsar({
    asarPath,
    backupPath,
    stampPath,
    extractDest,
    repackedDest,
    preloadRel,
    shimPath,
    markerText,
    bootstrapRel,
    cloneShimPath,
    cloneMarkerText,
    patchVersion,
    donePath,
  })
  if (!rs.ok) process.exit(1)
}

module.exports = { patchAsar }

if (require.main === module) {
  main()
}
