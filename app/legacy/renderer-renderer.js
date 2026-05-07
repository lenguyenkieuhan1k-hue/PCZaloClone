/* globals: window.api */
'use strict'

let profiles = []
let ctxTarget = null
let zaloReady = false
// Deduplicate identical error dialogs triggered by concurrent profile launches
let _lastLaunchErrorMsg = null
let _lastLaunchErrorTs = 0

const $ = (id) => document.getElementById(id)

window.addEventListener('DOMContentLoaded', async () => {
  window.api.onInstallProgress((msg) => {
    logTools(msg)
    if (/san sang/i.test(msg)) { zaloReady = true; hideInstallOverlay() }
  })

  const status = await window.api.getZaloStatus()
  if (status.exe) {
    zaloReady = true
  } else if (status.setup) {
    showInstallOverlay('Dang giai nen Zalo lan dau, vui long cho...')
    const result = await window.api.autoInstall()
    if (result.ok) { zaloReady = true; hideInstallOverlay() }
    else setInstallOverlayError(result.message)
  } else {
    showInstallOverlay('Chua tim thay Zalo.')
    setInstallOverlayManual()
  }

  await refreshList()

  document.querySelectorAll('.main-tab').forEach(btn =>
    btn.addEventListener('click', () => switchMainTab(btn.dataset.tab)))
  document.querySelectorAll('.modal-tab').forEach(btn =>
    btn.addEventListener('click', () => switchModalTab(btn.dataset.mtab)))

  $('btnClose').addEventListener('click', () => window.api.closeWindow())
  $('btnMinimize').addEventListener('click', () => window.api.minimizeWindow())

  $('btnAddAccount').addEventListener('click', () => openModal())
  $('emptyAddLink').addEventListener('click', (e) => { e.preventDefault(); openModal() })
  $('btnExport').addEventListener('click', openExportOverlay)
  $('btnImport').addEventListener('click', handleImport)
  $('btnSort').addEventListener('click', sortProfiles)

  $('webClose').addEventListener('click', closeWebOverlay)
  $('webCancel').addEventListener('click', closeWebOverlay)
  $('webOverlay').addEventListener('click', (e) => { if (e.target === $('webOverlay')) closeWebOverlay() })
  $('webConfirm').addEventListener('click', handleAddWebProfile)

  $('exportClose').addEventListener('click', closeExportOverlay)
  $('exportCancel').addEventListener('click', closeExportOverlay)
  $('exportOverlay').addEventListener('click', (e) => { if (e.target === $('exportOverlay')) closeExportOverlay() })
  $('exportConfirm').addEventListener('click', handleExport)

  $('modalClose').addEventListener('click', closeModal)
  $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal() })
  $('btnModalAdd').addEventListener('click', handleAddAccount)
  $('chkProxy').addEventListener('change', toggleProxyFields)
  $('chkAuth').addEventListener('change', toggleAuthFields)
  $('btnTestProxy').addEventListener('click', testProxy)
  $('btnQuickImport').addEventListener('click', quickImportProxy)

  $('inputDisplayName').addEventListener('input', () => {
    const slug = $('inputDisplayName').value.trim()
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    if (slug) $('inputProfileName').value = slug
  })

  const btnLaunchAll = $('btnLaunchAll')
  if (btnLaunchAll) btnLaunchAll.addEventListener('click', handleLaunchAll)
  const btnOpenFolder = $('btnOpenFolder')
  if (btnOpenFolder) btnOpenFolder.addEventListener('click', () => window.api.openProfilesFolder())
  const btnPickInstall = $('btnPickInstall')
  if (btnPickInstall) btnPickInstall.addEventListener('click', async () => {
    const result = await window.api.pickAndInstall()
    if (result.ok) { zaloReady = true; logTools('Zalo san sang: ' + result.exe) }
    else logTools('LOI: ' + result.message)
  })

  // Privacy toggles
  const settings = await window.api.getSettings()
  const privacyKeys = ['hideTyping', 'hideSeen', 'hideReceived']
  privacyKeys.forEach(key => {
    const el = $('chk' + key.charAt(0).toUpperCase() + key.slice(1))
    if (!el) return
    el.checked = !!settings[key]
    el.addEventListener('change', async () => {
      const nextValue = el.checked
      const result = await window.api.setSetting({ key, value: nextValue })
      if (result && result.ok) return
      el.checked = !nextValue
      if (result && result.message) alert(result.message)
    })
  })

  $('ctxLaunch').addEventListener('click', handleCtxLaunch)
  $('ctxDelete').addEventListener('click', handleCtxDelete)
  document.addEventListener('click', hideCtxMenu)
  toggleProxyFields()

  $('proxyEditClose').addEventListener('click', closeProxyEdit)
  $('proxyEditOverlay').addEventListener('click', (e) => { if (e.target === $('proxyEditOverlay')) closeProxyEdit() })
  $('btnSaveProxy').addEventListener('click', handleSaveProxy)
  $('btnCheckProxy').addEventListener('click', handleCheckProxy)
  $('btnDisableProxy').addEventListener('click', handleDisableProxy)

  const btnHealth = $('btnHealthRefresh')
  if (btnHealth) btnHealth.addEventListener('click', refreshHealthSummary)
  const btnSupportLog = $('btnExportSupportLog')
  if (btnSupportLog) btnSupportLog.addEventListener('click', handleExportSupportLog)
  refreshHealthSummary()
})

async function refreshHealthSummary() {
  const target = $('healthSummary')
  if (!target) return
  target.textContent = 'Đang kiểm tra...'
  try {
    const result = await window.api.getSystemHealth()
    if (!result.ok) {
      target.textContent = 'Lỗi kiểm tra: ' + (result.message || 'không rõ')
      return
    }
    const info = result.info || {}
    const warnings = result.warnings || []
    const summary = warnings.length === 0
      ? `OK • ${info.profileCount || 0} profile (${info.cloneCount || 0} clone, ${info.webCount || 0} web, ${info.desktopCount || 0} desktop) • app v${info.appVersion || '?'}`
      : `${warnings.length} cảnh báo: ${warnings.join('; ')}`
    target.textContent = summary
    target.style.color = warnings.length === 0 ? '#22c55e' : '#ef4444'
  } catch (e) {
    target.textContent = 'Không kiểm tra được: ' + e.message
    target.style.color = '#ef4444'
  }
}

async function handleExportSupportLog() {
  const btn = $('btnExportSupportLog')
  if (!btn) return
  await withBusyButton(btn, 'Đang xuất...', async () => {
    const result = await window.api.exportSupportLog()
    if (result.ok) {
      alert('✅ Đã xuất log hỗ trợ.\nGửi file zip này cho support khi gặp lỗi.\n\nĐường dẫn: ' + result.path)
    } else {
      alert('❌ ' + (result.message || 'Không xuất được log.'))
    }
  })
}

let proxyEditTarget = null

function openProxyEdit(profile) {
  proxyEditTarget = profile.profileName
  $('proxyEditTitle').textContent = profile.displayName
  const px = profile.proxy || {}
  $('peProtocol').value = px.protocol || 'HTTP'
  $('peCheckResult').textContent = ''
  $('peErrRaw').classList.add('hidden')
  // Rebuild raw string from saved proxy
  if (px.host && px.port) {
    if (px.authEnabled && px.username) {
      $('peFormat').value = 'h:p:u:pw'
      $('peRaw').value = `${px.host}:${px.port}:${px.username}:${px.password || ''}`
    } else {
      $('peFormat').value = 'h:p'
      $('peRaw').value = `${px.host}:${px.port}`
    }
  } else {
    $('peRaw').value = ''
  }
  $('proxyEditOverlay').classList.remove('hidden')
}

function parseRawProxy(raw, fmt) {
  raw = (raw || '').trim()
  if (!raw) return null
  if (fmt === 'h:p:u:pw') {
    const m = raw.match(/^([^:]+):(\d+):([^:]+):(.*)$/)
    if (!m) return null
    return { host: m[1], port: parseInt(m[2]), username: m[3], password: m[4], authEnabled: true }
  }
  if (fmt === 'u:pw@h:p') {
    const m = raw.match(/^([^:@]+):([^@]*)@([^:]+):(\d+)$/)
    if (!m) return null
    return { host: m[3], port: parseInt(m[4]), username: m[1], password: m[2], authEnabled: true }
  }
  if (fmt === 'h:p@u:pw') {
    const m = raw.match(/^([^:]+):(\d+)@([^:]+):(.*)$/)
    if (!m) return null
    return { host: m[1], port: parseInt(m[2]), username: m[3], password: m[4], authEnabled: true }
  }
  // h:p
  const m = raw.match(/^([^:]+):(\d+)$/)
  if (!m) return null
  return { host: m[1], port: parseInt(m[2]), username: '', password: '', authEnabled: false }
}

function closeProxyEdit() {
  proxyEditTarget = null
  $('proxyEditOverlay').classList.add('hidden')
}

async function handleDisableProxy() {
  if (!proxyEditTarget) return
  await withBusyButton($('btnDisableProxy'), 'Đang tắt...', () =>
    window.api.updateProxy({ profileName: proxyEditTarget, proxy: { enabled: false } }))
  closeProxyEdit()
  await refreshList()
}

async function handleCheckProxy() {
  const parsed = parseRawProxy($('peRaw').value, $('peFormat').value)
  if (!parsed) { $('peErrRaw').classList.remove('hidden'); return }
  $('peErrRaw').classList.add('hidden')
  $('peCheckResult').style.color = '#888'
  $('peCheckResult').textContent = '⏳ Đang kiểm tra...'
  const result = await withBusyButton($('btnCheckProxy'), 'Đang kiểm tra...', () => window.api.checkProxy({
    protocol: $('peProtocol').value.toLowerCase(),
    host: parsed.host, port: parsed.port,
    username: parsed.username, password: parsed.password
  }))
  if (result.ok) {
    $('peCheckResult').style.color = '#22c55e'
    $('peCheckResult').textContent = '✅ Live — IP: ' + (result.ip || 'OK')
  } else {
    $('peCheckResult').style.color = '#ef4444'
    $('peCheckResult').textContent = '❌ ' + result.message
  }
}

async function handleSaveProxy() {
  if (!proxyEditTarget) return
  const raw = $('peRaw').value.trim()
  if (!raw) {
    await withBusyButton($('btnSaveProxy'), 'Đang lưu...', () =>
      window.api.updateProxy({ profileName: proxyEditTarget, proxy: { enabled: false } }))
    closeProxyEdit(); await refreshList(); return
  }
  const parsed = parseRawProxy(raw, $('peFormat').value)
  if (!parsed) { $('peErrRaw').classList.remove('hidden'); return }
  $('peErrRaw').classList.add('hidden')
  const proxy = {
    enabled: true,
    protocol: $('peProtocol').value,
    host: parsed.host, port: parsed.port,
    authEnabled: parsed.authEnabled,
    username: parsed.username, password: parsed.password
  }
  const result = await withBusyButton($('btnSaveProxy'), 'Đang lưu...', () =>
    window.api.updateProxy({ profileName: proxyEditTarget, proxy }))
  if (result.ok) { closeProxyEdit(); await refreshList() }
  else alert(result.message)
}

function showInstallOverlay(msg) {
  $('installOverlay').classList.remove('hidden')
  $('installMsg').textContent = msg
  $('installSpinner').style.display = 'block'
  $('installPickBtn').classList.add('hidden')
}
function hideInstallOverlay() { $('installOverlay').classList.add('hidden') }
function setInstallOverlayError(msg) {
  $('installSpinner').style.display = 'none'
  $('installMsg').textContent = 'Loi: ' + msg
  setInstallOverlayManual()
}
function setInstallOverlayManual() {
  $('installSpinner').style.display = 'none'
  $('installPickBtn').classList.remove('hidden')
  $('installPickBtn').onclick = async () => {
    $('installPickBtn').disabled = true
    $('installSpinner').style.display = 'block'
    $('installMsg').textContent = 'Dang xu ly...'
    const result = await window.api.pickAndInstall()
    if (result.ok) { zaloReady = true; hideInstallOverlay() }
    else setInstallOverlayError(result.message)
  }
}

function switchMainTab(tab) {
  document.querySelectorAll('.main-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab))
  if (tab === 'cloud') refreshCloudTab().catch(() => {})
}

let _cloudProviders = []

function formatRelativeTime(iso) {
  if (!iso) return 'chưa có'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const seconds = Math.floor((Date.now() - t) / 1000)
  if (seconds < 60) return seconds + ' giây trước'
  if (seconds < 3600) return Math.floor(seconds / 60) + ' phút trước'
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' giờ trước'
  return Math.floor(seconds / 86400) + ' ngày trước'
}

async function refreshCloudTab() {
  const statusEl = $('cloudProviderStatus')
  const listEl = $('cloudList')
  const emptyEl = $('cloudEmpty')
  if (!statusEl || !listEl) return

  // Provider status
  try {
    const resp = await window.api.cloudListProviders()
    if (resp && resp.ok && Array.isArray(resp.providers)) {
      _cloudProviders = resp.providers
      const supabase = resp.providers.find(p => p.kind === 'supabase')
      const local = resp.providers.find(p => p.kind === 'local')
      const lines = []
      if (local) lines.push('Local: ' + (local.status?.message || 'OK'))
      if (supabase) lines.push('Supabase: ' + (supabase.status?.message || 'chưa cấu hình'))
      statusEl.textContent = lines.join(' • ') || 'Chưa có provider'
    } else {
      statusEl.textContent = 'Không đọc được trạng thái provider'
    }
  } catch (e) {
    statusEl.textContent = 'Lỗi: ' + (e?.message || e)
  }

  // Snapshot list
  let snapshots = []
  try {
    const resp = await window.api.cloudListSnapshots()
    if (resp && resp.ok && Array.isArray(resp.snapshots)) snapshots = resp.snapshots
  } catch (_) {}

  // Wipe previous rows but keep the empty placeholder element.
  Array.from(listEl.querySelectorAll('.cloud-row')).forEach(node => node.remove())

  if (!snapshots.length) {
    if (emptyEl) emptyEl.style.display = ''
    return
  }
  if (emptyEl) emptyEl.style.display = 'none'

  const supabaseConfigured = _cloudProviders.some(p => p.kind === 'supabase' && p.status?.configured)

  for (const snap of snapshots) {
    const row = document.createElement('div')
    row.className = 'cloud-row'

    const info = document.createElement('div')
    info.className = 'cloud-row-info'
    const name = document.createElement('span')
    name.className = 'cloud-row-name'
    name.textContent = snap.displayName || snap.profileName
    info.appendChild(name)
    const sub = document.createElement('span')
    sub.className = 'cloud-row-sub'
    sub.textContent = `Profile: ${snap.profileName} • z_uuid: ${snap.zUuid ? snap.zUuid.slice(0, 12) + '…' : 'chưa có'} • Cookies: ${snap.cookieCount || 0} • Cập nhật: ${formatRelativeTime(snap.lastCollectedAt)}`
    info.appendChild(sub)
    row.appendChild(info)

    const actions = document.createElement('div')
    actions.className = 'cloud-row-actions'

    const refreshSeedBtn = document.createElement('button')
    refreshSeedBtn.className = 'acc-btn'
    refreshSeedBtn.textContent = 'Ghi seed'
    refreshSeedBtn.title = 'Ghi lại file zalomask-seed.json để Zalo dùng identity này ở lần mở kế tiếp'
    refreshSeedBtn.addEventListener('click', async () => {
      const restore = setButtonBusy(refreshSeedBtn, '...')
      try {
        const resp = await window.api.cloudRefreshSeed({ profileName: snap.profileName })
        alert(resp?.ok ? 'Đã ghi seed.' : ('Lỗi: ' + (resp?.message || 'unknown')))
      } finally { restore() }
    })
    actions.appendChild(refreshSeedBtn)

    const pushBtn = document.createElement('button')
    pushBtn.className = 'acc-btn'
    pushBtn.textContent = 'Đẩy lên cloud'
    if (!supabaseConfigured) {
      pushBtn.disabled = true
      pushBtn.title = 'Cần cấu hình Supabase ở Phase 2 mới đẩy được'
    } else {
      pushBtn.addEventListener('click', async () => {
        const restore = setButtonBusy(pushBtn, '...')
        try {
          const resp = await window.api.cloudPushSnapshot({ profileName: snap.profileName, providerKey: 'supabase' })
          alert(resp?.ok ? 'Đã đẩy lên cloud.' : ('Lỗi: ' + (resp?.message || 'unknown')))
          await refreshCloudTab()
        } finally { restore() }
      })
    }
    actions.appendChild(pushBtn)

    const pullBtn = document.createElement('button')
    pullBtn.className = 'acc-btn'
    pullBtn.textContent = 'Kéo từ cloud'
    if (!supabaseConfigured) {
      pullBtn.disabled = true
      pullBtn.title = 'Cần cấu hình Supabase ở Phase 2 mới kéo được'
    } else {
      pullBtn.addEventListener('click', async () => {
        const restore = setButtonBusy(pullBtn, '...')
        try {
          const resp = await window.api.cloudPullSnapshot({ profileName: snap.profileName, providerKey: 'supabase' })
          alert(resp?.ok ? 'Đã kéo về cloud.' : ('Lỗi: ' + (resp?.message || 'unknown')))
          await refreshCloudTab()
        } finally { restore() }
      })
    }
    actions.appendChild(pullBtn)

    row.appendChild(actions)
    listEl.appendChild(row)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnCloudRefresh')
  if (btn) btn.addEventListener('click', () => refreshCloudTab().catch(() => {}))
  initUpdateUI()
})

/* ---------- Auto-update UI ---------- */

let _updateAvailable = null

function showUpdateModal(info) {
  _updateAvailable = info || _updateAvailable
  if (!_updateAvailable) return
  $('updateLocalVer').textContent = _updateAvailable.localVersion || '-'
  $('updateRemoteVer').textContent = _updateAvailable.remoteVersion || '-'
  $('updateNotes').textContent = _updateAvailable.releaseNotes || '(Không có ghi chú phát hành)'
  $('updateOverlay').classList.remove('hidden')
  $('updateProgress').classList.add('hidden')
  $('updateStatus').textContent = ''
  $('updateConfirm').disabled = false
  $('updateBarFill').style.width = '0%'
}

function hideUpdateModal() {
  $('updateOverlay').classList.add('hidden')
}

async function handleUpdateConfirm() {
  const confirm = $('updateConfirm')
  confirm.disabled = true
  $('updateProgress').classList.remove('hidden')
  $('updateStatus').textContent = 'Đang tải bản cập nhật...'
  const dl = await window.api.updateDownload()
  if (!dl || !dl.ok) {
    $('updateStatus').textContent = 'Lỗi: ' + (dl?.message || 'không tải được')
    confirm.disabled = false
    return
  }
  $('updateStatus').textContent = 'Tải xong. Đang chạy installer, app sẽ tắt...'
  const ins = await window.api.updateInstall()
  if (!ins || !ins.ok) {
    $('updateStatus').textContent = 'Lỗi cài đặt: ' + (ins?.message || 'unknown')
    confirm.disabled = false
  }
}

function initUpdateUI() {
  const pill = $('updatePill')
  if (pill) pill.addEventListener('click', () => showUpdateModal())
  const close = $('updateClose')
  if (close) close.addEventListener('click', hideUpdateModal)
  const later = $('updateLater')
  if (later) later.addEventListener('click', hideUpdateModal)
  const confirm = $('updateConfirm')
  if (confirm) confirm.addEventListener('click', () => handleUpdateConfirm().catch(() => {}))

  if (window.api.onUpdateAvailable) {
    window.api.onUpdateAvailable((info) => {
      _updateAvailable = info
      const pillEl = $('updatePill')
      if (pillEl) {
        pillEl.classList.remove('hidden')
        pillEl.title = `Bản ${info.remoteVersion} đã sẵn sàng`
      }
      // Auto-popup once on first detection per session.
      showUpdateModal(info)
    })
  }
  if (window.api.onUpdateProgress) {
    window.api.onUpdateProgress((info) => {
      const pct = Math.round((info.percent || 0) * 100)
      $('updateBarFill').style.width = pct + '%'
      $('updateProgressText').textContent = pct + '% (' + Math.round((info.received || 0) / 1024 / 1024) + ' / ' + Math.round((info.total || 0) / 1024 / 1024) + ' MB)'
    })
  }
}

function setButtonBusy(button, busyText) {
  if (!button) return () => {}
  const originalText = button.textContent
  button.disabled = true
  button.dataset.busy = '1'
  button.textContent = busyText || 'Đang xử lý...'
  return () => {
    button.disabled = false
    button.dataset.busy = ''
    button.textContent = originalText
  }
}

async function withBusyButton(button, busyText, task) {
  const restore = setButtonBusy(button, busyText)
  try {
    return await task()
  } finally {
    restore()
  }
}

function hashProfileSeed(text) {
  let hash = 2166136261
  const value = String(text || '')
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function getAvatarLabel(profile) {
  const raw = (profile.displayName || profile.profileName || '?').trim()
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  const compact = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (compact.length >= 2) return compact.slice(0, 2)
  return compact || raw.slice(0, 1).toUpperCase() || '?'
}

function getAvatarTheme(profile) {
  const seed = hashProfileSeed(`${profile.profileName}|${profile.displayName}`)
  const hueA = seed % 360
  const hueB = (hueA + 46 + (seed % 37)) % 360
  const hueC = (hueA + 180) % 360
  const angle = 115 + (seed % 35)
  const label = getAvatarLabel(profile)
  const style = [
    `--av-angle:${angle}deg`,
    `--av-start:hsl(${hueA} 82% 58%)`,
    `--av-end:hsl(${hueB} 78% 46%)`,
    `--av-glow:hsla(${hueC} 95% 88% / 0.95)`,
    `--av-ring:hsla(${(hueB + 24) % 360} 95% 98% / 0.42)`,
    `--av-shadow:hsla(${hueA} 85% 45% / 0.28)`
  ].join(';')
  return { label, style }
}

async function refreshList() {
  profiles = await window.api.listProfiles()
  renderList()
}

function renderList() {
  $('listCount').textContent = 'Danh sach (' + profiles.length + ')'
  const list = $('accountList')
  Array.from(list.querySelectorAll('.account-row')).forEach(n => n.remove())
  $('emptyState').style.display = profiles.length === 0 ? 'flex' : 'none'
  profiles.forEach(p => {
    const row = document.createElement('div')
    row.className = 'account-row'
    const avatar = getAvatarTheme(p)
    const modeBadge = p.launchMode === 'web'
      ? '<span class="acc-proxy-badge">Web</span>'
      : (p.launchMode === 'clone' ? '<span class="acc-proxy-badge">Clone</span>' : '')
    const proxyBadge = p.proxy && p.proxy.enabled ? '<span class="acc-proxy-badge">Proxy</span>' : ''
    const pingBtn = p.proxy && p.proxy.enabled
      ? '<button class="acc-btn ping-btn" title="Kiểm tra proxy">Ping</button>'
      : ''
    const locationBtn = p.proxy && p.proxy.enabled
      ? '<button class="acc-btn location-btn" title="Xem vị trí proxy">Vị trí</button>'
      : ''
    const proxyDot = p.proxy && p.proxy.enabled
      ? '<span class="acc-avatar-status" title="Proxy đang bật"></span>'
      : ''
    row.innerHTML = '<div class="acc-avatar" style="' + avatar.style + '"><span class="acc-avatar-label">' + escHtml(avatar.label) + '</span><span class="acc-avatar-core"></span>' + proxyDot + '</div>' +
      '<div class="acc-info"><div class="acc-name">' + escHtml(p.displayName) + '</div>' +
      '<div class="acc-meta">Tao luc: ' + formatDate(p.createdAt) + ' ' + modeBadge + ' ' + proxyBadge + '<span class="ping-result"></span></div></div>' +
      '<div class="acc-actions"><button class="acc-btn launch-btn">一Mở</button><button class="acc-btn proxy-btn" title="Cai dat proxy">Proxy</button>' + pingBtn + locationBtn + '<button class="acc-btn danger delete-btn">Xoa</button></div>'
    row.querySelector('.launch-btn').addEventListener('click', (e) => { e.stopPropagation(); launchProfile(p.profileName, e.currentTarget) })
    row.querySelector('.proxy-btn').addEventListener('click', (e) => { e.stopPropagation(); openProxyEdit(p) })
    if (p.proxy && p.proxy.enabled) {
      row.querySelector('.ping-btn').addEventListener('click', (e) => { e.stopPropagation(); quickCheckProxy(p, row) })
      row.querySelector('.location-btn').addEventListener('click', (e) => { e.stopPropagation(); checkProxyLocation(p, row) })
    }
    row.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(p.profileName, e.currentTarget) })
    row.addEventListener('dblclick', () => launchProfile(p.profileName))
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); ctxTarget = p.profileName; showCtxMenu(e.clientX, e.clientY) })
    list.appendChild(row)
  })
}

async function quickCheckProxy(profile, row) {
  const pingBtn = row.querySelector('.ping-btn')
  const pingResult = row.querySelector('.ping-result')
  if (!pingBtn) return
  pingResult.textContent = ''
  const px = profile.proxy
  const result = await withBusyButton(pingBtn, 'Đang ping...', () => window.api.checkProxy({
    host: px.host, port: px.port,
    username: px.authEnabled ? px.username : '',
    password: px.authEnabled ? px.password : ''
  }))
  if (result.ok) {
    pingResult.style.color = '#22c55e'
    pingResult.textContent = ' ✅ ' + (result.ip || 'Live')
  } else {
    pingResult.style.color = '#ef4444'
    pingResult.textContent = ' ❌ ' + result.message
  }
}

async function checkProxyLocation(profile, row) {
  const locationBtn = row.querySelector('.location-btn')
  const pingResult = row.querySelector('.ping-result')
  if (!locationBtn) return
  pingResult.textContent = ''
  const px = profile.proxy
  const result = await withBusyButton(locationBtn, 'Đang tìm...', () => window.api.checkProxyLocation({
    protocol: px.protocol || 'HTTP',
    host: px.host, port: px.port,
    username: px.authEnabled ? px.username : '',
    password: px.authEnabled ? px.password : ''
  }))
  if (result.ok) {
    const parts = [result.city, result.region, result.country].filter(Boolean)
    pingResult.style.color = '#0ea5e9'
    pingResult.textContent = ' 📍 ' + (parts.join(', ') || result.ip || 'Không rõ vị trí')
    alert('Proxy đang ra tại: ' + (parts.join(', ') || 'Không rõ') + (result.ip ? `\nIP: ${result.ip}` : '') + (result.isp ? `\nISP: ${result.isp}` : ''))
  } else {
    pingResult.style.color = '#ef4444'
    pingResult.textContent = ' ❌ ' + result.message
  }
}

function sortProfiles() {
  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName))
  renderList()
}

function formatDate(iso) {
  try {
    const d = new Date(iso)
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') +
      ' ' + d.getDate() + '/' + (d.getMonth()+1) + '/' + String(d.getFullYear()).slice(2)
  } catch { return '' }
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

async function launchProfile(profileName, button = null) {
  const profile = profiles.find((item) => item.profileName === profileName)
  if (profile?.launchMode !== 'web' && !zaloReady) { alert('Zalo chua san sang. Xem tab Cong cu.'); return }
  const result = await withBusyButton(button, 'Đang mở...', () => window.api.launchProfile({ profileName }))
  if (!result.ok) {
    const now = Date.now()
    if (result.message !== _lastLaunchErrorMsg || now - _lastLaunchErrorTs > 3000) {
      _lastLaunchErrorMsg = result.message
      _lastLaunchErrorTs = now
      alert(result.message)
    }
  }
}

async function deleteProfile(profileName, button = null) {
  if (!confirm('Xoa profile "' + profileName + '"? Toan bo du lieu se mat.')) return
  const result = await withBusyButton(button, 'Đang xoá...', () => window.api.removeProfile({ profileName }))
  if (result.ok) await refreshList()
  else alert(result.message)
}

async function handleLaunchAll() {
  if (!zaloReady) { alert('Zalo chua san sang. Xem tab Cong cu.'); return }
  const result = await withBusyButton($('btnLaunchAll'), 'Đang mở tất cả...', () => window.api.launchAll())
  logTools(result.message)
}

function logTools(msg) {
  const box = $('logBox')
  const time = new Date().toLocaleTimeString('vi-VN')
  box.textContent += '[' + time + '] ' + msg + '\n'
  box.scrollTop = box.scrollHeight
}

function showCtxMenu(x, y) {
  const m = $('ctxMenu')
  m.style.left = x + 'px'; m.style.top = y + 'px'
  m.classList.remove('hidden')
}
function hideCtxMenu() { $('ctxMenu').classList.add('hidden') }
function handleCtxLaunch() { if (ctxTarget) launchProfile(ctxTarget) }
function handleCtxDelete() { if (ctxTarget) deleteProfile(ctxTarget) }

function openModal() {
  resetModal()
  $('modalTitle').textContent = 'Thêm Zalo'
  $('modalInfoHint').textContent = '(ví dụ: Zalo 1, Zalo 2,..)'
  $('btnModalAdd').textContent = 'Thêm Zalo'
  $('modalOverlay').classList.remove('hidden')
  setTimeout(() => {
    const inp = $('inputDisplayName')
    if (inp) { inp.focus(); inp.select() }
  }, 50)
}
function closeModal() { $('modalOverlay').classList.add('hidden') }

// -- Export / Import ----------------------------------------------------------

function openExportOverlay() {
  const sel = $('exportSelect')
  sel.innerHTML = ''
  if (!profiles.length) {
    $('exportStatus').style.color = '#999'
    $('exportStatus').textContent = 'Chưa có profile nào.'
    $('exportConfirm').disabled = true
  } else {
    profiles.forEach(p => {
      const opt = document.createElement('option')
      opt.value = p.profileName
      opt.textContent = p.displayName
      sel.appendChild(opt)
    })
    $('exportStatus').textContent = ''
    $('exportConfirm').disabled = false
  }
  $('exportOverlay').classList.remove('hidden')
}

function closeExportOverlay() { $('exportOverlay').classList.add('hidden') }

function openWebOverlay() {
  $('webDisplayName').value = ''
  $('webZUuid').value = ''
  $('webCookies').value = ''
  $('webErr').classList.add('hidden')
  $('webOverlay').classList.remove('hidden')
}

function closeWebOverlay() { $('webOverlay').classList.add('hidden') }

function slugifyProfileName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function parseWebSessionInput(rawText, zUuidInput) {
  const raw = String(rawText || '').trim()
  const zUuid = String(zUuidInput || '').trim()
  if (!raw) return { ok: false, message: 'Thiếu cookies hoặc JSON export.' }
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw)
      const session = data.session || {}
      const me = data.me || {}
      const cookies = Array.isArray(data.cookies) ? data.cookies : null
      const cookieString = cookies && cookies.length ? '' : (data.cookieString || data.cookie || '')
      const parsedZUuid = zUuid || data.z_uuid || data.zUuid || data.imei || session.imei || ''
      const displayName = me.displayName || me.zaloName || me.name || data.displayName || ''
      const sessionInfo = {
        userId: session.userId || data.userId || me.userId || '',
        UIN: session.UIN || data.UIN || '',
        imei: session.imei || data.imei || parsedZUuid || '',
      }
      return {
        ok: !!(cookies?.length || cookieString) && !!parsedZUuid,
        cookieString,
        cookieList: cookies,
        zUuid: parsedZUuid,
        proxy: data.proxy || null,
        displayName,
        sessionInfo,
        message: 'Thiếu cookies hoặc z_uuid trong JSON.'
      }
    } catch {
      return { ok: false, message: 'JSON không hợp lệ.' }
    }
  }
  return { ok: !!raw && !!zUuid, cookieString: raw, cookieList: null, zUuid, message: 'Thiếu cookies hoặc z_uuid hợp lệ.' }
}

async function handleAddWebProfile() {
  const parsed = parseWebSessionInput($('webCookies').value, $('webZUuid').value)
  const displayName = $('webDisplayName').value.trim() || parsed.displayName || 'Zalo Web'
  const profileName = slugifyProfileName(displayName || 'zalo_web')
  if (!displayName || !profileName || !parsed.ok) {
    $('webErr').textContent = parsed.message || 'Thiếu tên hiển thị, cookies hoặc z_uuid hợp lệ.'
    $('webErr').classList.remove('hidden')
    return
  }

  $('webErr').classList.add('hidden')
  const result = await withBusyButton($('webConfirm'), 'Đang thêm...', () => window.api.addWebProfile({
    profileName,
    displayName,
    proxy: parsed.proxy,
    cookieString: parsed.cookieString,
    cookieList: parsed.cookieList,
    zUuid: parsed.zUuid,
    sessionInfo: parsed.sessionInfo,
  }))
  if (!result.ok) {
    $('webErr').textContent = result.message || 'Không tạo được Web profile.'
    $('webErr').classList.remove('hidden')
    return
  }

  closeWebOverlay()
  await refreshList()
}

async function handleExport() {
  const profileName = $('exportSelect').value
  if (!profileName) return
  $('exportStatus').style.color = '#555'
  $('exportStatus').textContent = 'Đang sao lưu...'
  const result = await withBusyButton($('exportConfirm'), 'Đang sao lưu...', () => window.api.exportProfile({ profileName }))
  if (result.ok) {
    $('exportStatus').style.color = '#22c55e'
    $('exportStatus').textContent = `✅ Đã sao lưu xong! File .zmask đã lưu (${result.sessionFileCount || 0} tệp dữ liệu, ${result.cookieCount || 0} cookies).`
    closeExportOverlay()
  } else {
    $('exportStatus').style.color = '#ef4444'
    $('exportStatus').textContent = '❌ ' + result.message
  }
}

async function handleImport() {
  const result = await withBusyButton($('btnImport'), 'Đang khôi phục...', () => window.api.importProfile())
  if (!result.ok) {
    if (result.message !== 'Đã huỷ') alert('Khôi phục thất bại: ' + result.message)
    return
  }
  await refreshList()
  if (result.launchMode === 'web') {
    alert('✅ Đã khôi phục Zalo Web "' + result.displayName + '" thành công!\n\nCửa sổ Zalo Web đã mở, bạn có thể sử dụng ngay không cần đăng nhập lại.')
    return
  }
  if (result.launchMode === 'clone') {
    alert(`✅ Đã khôi phục clone "${result.displayName}" thành công!\n\nProxy từ file sao lưu đã được nhập nhưng đang tắt mặc định để tránh lỗi "Không có internet". Nếu cần, hãy bật lại trong mục Proxy.`)
    return
  }
  alert(`✅ Đã khôi phục profile "${result.displayName}" thành công!\n\nProxy từ file sao lưu đã được nhập nhưng đang tắt mặc định để tránh lỗi mạng.`)
}
function resetModal() {
  $('inputDisplayName').value = ''
  $('inputProfileName').value = ''
  $('errInfo').classList.add('hidden')
  $('chkProxy').checked = false
  $('proxyHost').value = ''; $('proxyPort').value = ''
  $('proxyUser').value = ''; $('proxyPass').value = ''
  $('chkAuth').checked = false
  $('errProxyHost').classList.add('hidden')
  $('errProxyPort').classList.add('hidden')
  switchModalTab('info')
  toggleProxyFields()
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab))
  document.querySelectorAll('.mtab-panel').forEach(p => p.classList.toggle('active', p.id === 'mtab-' + tab))
}

function toggleProxyFields() {
  const on = $('chkProxy').checked
  $('proxyFields').classList.toggle('hidden', !on)
}

function toggleAuthFields() {
  const on = $('chkAuth').checked
  $('authFields').classList.toggle('hidden', !on)
}

async function testProxy() {
  const btn = $('btnTestProxy')
  if (!btn) return
  const proxy = readProxyFromModal()
  if (!proxy) { alert('Vui lòng nhập đầy đủ thông tin proxy.'); return }
  await withBusyButton(btn, 'Đang kiểm tra...', async () => {
    const result = await window.api.checkProxy(proxy)
    if (result && result.ok) alert('✅ Proxy hoạt động.\nIP thực: ' + (result.ip || 'không xác định'))
    else alert('❌ Proxy lỗi: ' + (result?.message || 'không kết nối được'))
  })
}

function quickImportProxy() {
  const raw = prompt('Dán chuỗi proxy nhanh\n\nHỗ trợ: host:port, host:port:user:pass, user:pass@host:port, host:port@user:pass')
  if (!raw) return
  const parsed = parseRawProxy(raw, 'h:p:u:pw') || parseRawProxy(raw, 'u:pw@h:p')
    || parseRawProxy(raw, 'h:p@u:pw') || parseRawProxy(raw, 'h:p')
  if (!parsed) { alert('Không nhận diện được định dạng.'); return }
  $('proxyHost').value = parsed.host
  $('proxyPort').value = String(parsed.port || '')
  if (parsed.authEnabled) {
    $('chkAuth').checked = true
    $('proxyUser').value = parsed.username || ''
    $('proxyPass').value = parsed.password || ''
    toggleAuthFields()
  }
  $('chkProxy').checked = true
  toggleProxyFields()
}

function readProxyFromModal() {
  const enabled = $('chkProxy').checked
  if (!enabled) return null
  const host = $('proxyHost').value.trim()
  const port = parseInt($('proxyPort').value.trim(), 10)
  if (!host || !port) return null
  return {
    enabled: true,
    protocol: $('proxyProtocol').value,
    host, port,
    authEnabled: $('chkAuth').checked,
    username: $('proxyUser').value.trim(),
    password: $('proxyPass').value
  }
}

async function handleAddAccount() {
  const displayName = $('inputDisplayName').value.trim()
  if (!displayName) {
    $('errInfo').textContent = 'Vui lòng nhập tên hiển thị.'
    $('errInfo').classList.remove('hidden')
    switchModalTab('info')
    return
  }
  const profileName = $('inputProfileName').value.trim() || slugifyProfileName(displayName)
  const proxyEnabled = $('chkProxy').checked
  const portVal = parseInt($('proxyPort').value.trim(), 10)
  const portOk = !proxyEnabled || (Number.isInteger(portVal) && portVal > 0 && portVal < 65536)
  if (!portOk) {
    $('errProxyPort').classList.remove('hidden')
    switchModalTab('proxy')
    return
  }
  const proxy = { enabled: proxyEnabled, protocol: $('proxyProtocol').value, host: $('proxyHost').value.trim(), port: portOk ? portVal : 0, authEnabled: $('chkAuth').checked, username: $('proxyUser').value.trim(), password: $('proxyPass').value }
  const addAction = window.api.addCloneProfile
  const busyLabel = 'Đang tạo...'
  const result = await withBusyButton($('btnModalAdd'), busyLabel, () => addAction({ profileName, displayName, proxy }))
  if (result.ok) { closeModal(); await refreshList() }
  else { $('errInfo').textContent = result.message; $('errInfo').classList.remove('hidden'); switchModalTab('info') }
}
