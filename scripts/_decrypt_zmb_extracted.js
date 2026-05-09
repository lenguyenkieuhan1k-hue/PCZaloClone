'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Usage: node scripts/_decrypt_zmb_extracted.js <extractedDir>
const extractedDir = process.argv[2]
if (!extractedDir) {
  console.error('Usage: node scripts/_decrypt_zmb_extracted.js <extractedDir>')
  process.exit(2)
}

const manifestPath = path.join(extractedDir, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error('Missing manifest.json in', extractedDir)
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const p0 = (manifest.profiles || [])[0] || {}
const keyB64 = String(p0.cookieKeyB64 || '').trim()
if (!keyB64) {
  console.error('Missing cookieKeyB64 in manifest')
  process.exit(2)
}
const key = Buffer.from(keyB64, 'base64')
console.log('cookieKeyB64 len:', key.length)

let initSqlJs
try {
  initSqlJs = require(path.join(__dirname, '..', 'app', 'node_modules', 'sql.js'))
} catch (e) {
  console.error('Missing sql.js. Run npm install in app/.', e.message)
  process.exit(2)
}

function decryptV10(encrypted) {
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted)
  if (encrypted.length < 3 + 12 + 16) return null
  if (encrypted.slice(0, 3).toString() !== 'v10') return null
  const nonce = encrypted.slice(3, 3 + 12)
  const tag = encrypted.slice(encrypted.length - 16)
  const ct = encrypted.slice(3 + 12, encrypted.length - 16)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    return null
  }
}

async function inspectDb(dbPath) {
  console.log('\n==', dbPath)
  if (!fs.existsSync(dbPath)) {
    console.log('  missing')
    return
  }
  const SQL = await initSqlJs()
  const buf = fs.readFileSync(dbPath)
  const db = new SQL.Database(buf)
  let res
  try {
    res = db.exec('SELECT host_key, name, encrypted_value FROM cookies')
  } catch (e) {
    console.log('  query error:', e.message)
    return
  }
  const rows = res?.[0]?.values || []
  console.log('  rows:', rows.length)
  const wanted = new Set(['zpw_sek', '_remme_'])
  for (const [host, name, enc] of rows) {
    if (!wanted.has(String(name))) continue
    const b = enc instanceof Uint8Array ? Buffer.from(enc) : Buffer.from(enc || [])
    const pt = decryptV10(b)
    if (!pt) {
      console.log(`  ${name}@${host} decrypt FAIL prefix=${b.slice(0, 3).toString()}`)
      continue
    }
    const stripped = pt.length > 32 ? pt.slice(32).toString('utf8') : pt.toString('utf8')
    console.log(`  ${name}@${host} => ${stripped.slice(0, 120)}`)
  }
}

;(async () => {
  const relRoot = String(p0.relativeRoot || 'profiles/zalo_pc_1')
  const profRoot = path.join(extractedDir, relRoot.replace(/\//g, path.sep))
  const cloneId = String(p0.cloneId || '').trim()
  if (!cloneId) {
    console.error('Missing cloneId in manifest')
    process.exit(2)
  }
  const sessionRoot = path.join(
    profRoot,
    'AppData',
    'Roaming',
    '__zalomask_clone_env__',
    cloneId,
    'ElectronSessionData'
  )
  await inspectDb(path.join(sessionRoot, 'Network', 'Cookies'))
  await inspectDb(path.join(sessionRoot, 'Partitions', 'zalo', 'Network', 'Cookies'))
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e))
  process.exit(1)
})

