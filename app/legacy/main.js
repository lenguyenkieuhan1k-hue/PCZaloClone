'use strict'

const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// ===== Constants =====
const PROFILES_DIR = path.join(__dirname, '..', 'profiles')
const ZALO_URL = 'https://chat.zalo.me/'

// ===== State =====
let mainWindow = null
const openWindows = new Map() // profileName -> BrowserWindow

// Load capture script once at startup
let CAPTURE_SCRIPT = ''
try {
  CAPTURE_SCRIPT = fs.readFileSync(path.join(__dirname, 'zalo-capture.js'), 'utf8')
} catch (e) {
  console.error('[ZaloMask] Failed to load zalo-capture.js:', e.message)
}

// ===== Utils =====
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadMeta(profileName) {
  const f = path.join(PROFILES_DIR, profileName, 'meta.json')
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

function saveMeta(profileName, meta) {
  const dir = path.join(PROFILES_DIR, profileName)
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

function listProfiles() {
  ensureDir(PROFILES_DIR)
  return fs.readdirSync(PROFILES_DIR)
    .filter(d => fs.existsSync(path.join(PROFILES_DIR, d, 'meta.json')))
    .map(d => loadMeta(d))
    .filter(m => m && !m.cloneId)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
}

function makeProfileName(displayName) {
  ensureDir(PROFILES_DIR)
  const base = (displayName || 'zalo')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20) || 'zalo'
  const existing = new Set(fs.readdirSync(PROFILES_DIR))
  if (!existing.has(base)) return base
  let i = 2
  while (existing.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

function getPartition(profileName) {
  return `persist:zalomask-${profileName}`
}

// ===== Cookie helpers =====
async function seedCookies(profileName, cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return
  const ses = session.fromPartition(getPartition(profileName))
  for (const c of cookies) {
    if (!c || !c.name) continue
    const host = (c.domain || '.zalo.me').replace(/^\./, '')
    try {
      const details = {
        url: 'https://' + host + (c.path || '/'),
        name: c.name,
        value: c.value,
        domain: c.domain || '.zalo.me',
        path: c.path || '/',
        httpOnly: Boolean(c.httpOnly),
        secure: c.secure !== false,
      }
      if (!c.session && typeof c.expirationDate === 'number' && isFinite(c.expirationDate)) {
        details.expirationDate = c.expirationDate
      }
      if (c.sameSite && c.sameSite !== 'unspecified') {
        details.sameSite = c.sameSite
      }
      await ses.cookies.set(details)
    } catch (_) {}
  }
}

async function readCookies(profileName) {
  const ses = session.fromPartition(getPartition(profileName))
  const all = await ses.cookies.getAll({ domain: '.zalo.me' })
  return all.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite,
    session: c.session,
  }))
}

// ===== IPC: preload asks for ls-seed synchronously =====
ipcMain.on('get-ls-seed', (event, profileName) => {
  const meta = loadMeta(profileName)
  event.returnValue = meta && meta.lsSnapshot ? meta.lsSnapshot : {}
})

// ===== Zalo window =====
function createZaloWindow(profileName, meta) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: meta.displayName || 'Zalo',
    webPreferences: {
      partition: getPartition(profileName),
      preload: path.join(__dirname, 'zalo-preload.js'),
      additionalArguments: ['--zalomask-profile=' + profileName],
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-finish-load', () => {
    if (CAPTURE_SCRIPT) {
      win.webContents.executeJavaScript(CAPTURE_SCRIPT).catch(() => {})
    }
  })

  win.loadURL(ZALO_URL)
  openWindows.set(profileName, win)
  win.on('closed', () => openWindows.delete(profileName))
  return win
}

// ===== Session capture from MAIN world =====
ipcMain.on('zalomask:capture', (event, data) => {
  const profileName = data && data.profileName
  if (!profileName) return
  const meta = loadMeta(profileName)
  if (!meta) return

  const me = data.me
  const ls = data.localStorage
  let changed = false

  if (me && typeof me === 'object') {
    if (me.displayName && me.displayName !== meta.displayName) { meta.displayName = me.displayName; changed = true }
    if (me.userId && me.userId !== meta.userId) { meta.userId = me.userId; changed = true }
    if (me.avatar && me.avatar !== meta.avatar) { meta.avatar = me.avatar; changed = true }
    if (me.phoneNumber && me.phoneNumber !== meta.phone) { meta.phone = me.phoneNumber; changed = true }
  }

  if (ls && typeof ls === 'object' && Object.keys(ls).length > 0) {
    meta.lsSnapshot = ls
    meta.capturedAt = new Date().toISOString()
    changed = true
  }

  if (changed) {
    saveMeta(profileName, meta)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profile-updated', profileName)
    }
  }
})

// ===== IPC Handlers =====
ipcMain.handle('list-profiles', () => listProfiles())

ipcMain.handle('add-profile', async (e, data) => {
  const displayName = data && data.displayName
  const profileName = makeProfileName(displayName || 'zalo')
  const meta = {
    displayName: displayName || 'Zalo Web',
    profileName,
    createdAt: new Date().toISOString(),
  }
  saveMeta(profileName, meta)
  createZaloWindow(profileName, meta)
  return { ok: true, profileName, displayName: meta.displayName }
})

ipcMain.handle('open-profile', async (e, data) => {
  const profileName = data && data.profileName
  if (openWindows.has(profileName)) {
    const w = openWindows.get(profileName)
    if (!w.isDestroyed()) { w.focus(); return { ok: true } }
  }
  const meta = loadMeta(profileName)
  if (!meta) return { ok: false, message: 'Profile khong ton tai' }
  createZaloWindow(profileName, meta)
  return { ok: true }
})

ipcMain.handle('delete-profile', async (e, data) => {
  const profileName = data && data.profileName
  const win = openWindows.get(profileName)
  if (win && !win.isDestroyed()) win.destroy()
  openWindows.delete(profileName)
  const dir = path.join(PROFILES_DIR, profileName)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true }
})

ipcMain.handle('export-profile', async (e, data) => {
  const profileName = data && data.profileName
  const meta = loadMeta(profileName)
  if (!meta) return { ok: false, message: 'Profile khong ton tai' }

  let cookies = []
  try { cookies = await readCookies(profileName) } catch (_) {}

  if (!cookies.length) {
    return { ok: false, message: 'Chua co du lieu phien. Hay mo profile va dang nhap Zalo truoc.' }
  }

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuat profile Zalo',
    defaultPath: 'ZaloMask_' + (meta.displayName || profileName) + '_' + new Date().toISOString().slice(0, 10) + '.json',
    filters: [{ name: 'ZaloMask Profile', extensions: ['json'] }],
  })

  if (!filePath) return { ok: false, message: 'Da huy' }

  const payload = {
    format: 'zalomask-web-v2',
    version: 1,
    exportedAt: new Date().toISOString(),
    displayName: meta.displayName || profileName,
    userId: meta.userId || '',
    avatar: meta.avatar || '',
    phone: meta.phone || '',
    cookies: cookies,
    localStorage: meta.lsSnapshot || {},
  }

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  return { ok: true, displayName: meta.displayName }
})

ipcMain.handle('import-profile', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhap profile Zalo',
    filters: [{ name: 'ZaloMask Profile', extensions: ['json'] }],
    properties: ['openFile'],
  })

  if (!filePaths || !filePaths[0]) return { ok: false, message: 'Da huy' }

  let payload
  try {
    payload = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
  } catch (_) { return { ok: false, message: 'File khong doc duoc hoac khong hop le' } }

  if (payload.format !== 'zalomask-web-v2') {
    return {
      ok: false,
      message: 'Dinh dang "' + (payload.format || 'khong xac dinh') + '" khong duoc ho tro.\nChi ho tro file xuat tu phien ban moi (zalomask-web-v2).',
    }
  }

  if (!Array.isArray(payload.cookies) || !payload.cookies.length) {
    return { ok: false, message: 'File khong chua cookie phien Zalo. Khong the khoi phuc.' }
  }

  const profileName = makeProfileName(payload.displayName || 'imported')
  const meta = {
    displayName: payload.displayName || 'Zalo Web',
    profileName,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    userId: payload.userId || '',
    avatar: payload.avatar || '',
    phone: payload.phone || '',
    lsSnapshot: payload.localStorage || {},
  }

  saveMeta(profileName, meta)
  await seedCookies(profileName, payload.cookies)
  createZaloWindow(profileName, meta)

  return { ok: true, profileName, displayName: meta.displayName }
})

ipcMain.on('close-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close() })
ipcMain.on('minimize-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize() })

// ===== Main window =====
app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    frame: false,
    backgroundColor: '#0068ff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})