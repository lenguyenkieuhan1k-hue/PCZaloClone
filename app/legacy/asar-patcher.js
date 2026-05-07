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

async function main () {
  const args = process.argv.slice(2)
  const [asarPath, backupPath, stampPath, extractDest, repackedDest,
         preloadRel, shimPath, markerText, bootstrapRel,
         cloneShimPath, cloneMarkerText, patchVersion, donePath] = args

  const writeDone = (msg) => {
    try { fs.writeFileSync(donePath, msg, 'utf8') } catch {}
  }

  try {
    // Step 0: Validate the asar is readable before doing anything destructive
    const { extractAll, extractFile, createPackage } = await import('@electron/asar')
    let preloadData
    try {
      preloadData = extractFile(asarPath, preloadRel)
    } catch {
      // If current asar is corrupt, try restoring from backup
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, asarPath)
        try { preloadData = extractFile(asarPath, preloadRel) } catch {
          writeDone('error:app.asar and backup are both unreadable')
          return
        }
      } else {
        writeDone('error:app.asar unreadable and no backup exists')
        return
      }
    }
    if (!Buffer.isBuffer(preloadData) || preloadData.length === 0) {
      writeDone('error:preload file is empty in asar: ' + preloadRel)
      return
    }

    // Step 1: Backup (runs in worker — copying 146MB here is fine, separate process)
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(asarPath, backupPath)
    }

    // Step 2: Extract
    fs.mkdirSync(extractDest, { recursive: true })
    extractAll(asarPath, extractDest)

    // Step 3: Patch the preload file
    const preloadFile = path.join(extractDest, preloadRel)
    if (!fs.existsSync(preloadFile)) {
      writeDone('error:preload not found after extract: ' + preloadRel)
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
    const bootstrapFile = path.join(extractDest, bootstrapRel)
    if (!fs.existsSync(bootstrapFile)) {
      writeDone('error:bootstrap not found after extract: ' + bootstrapRel)
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
  } catch (err) {
    writeDone('error:' + (err && err.message ? err.message : String(err)))
    process.exit(1)
  }
}

main()
