const $ = (id) => document.getElementById(id)
let profiles = []
let proxyTarget = null
let backupSelected = new Set()
let currentProfileInfoJson = ''

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function setStatus(text) {
  $('statusBar').textContent = text || 'Sẵn sàng'
}

function normalizeProtocol(raw) {
  const p = String(raw || '').trim().toUpperCase()
  if (p === 'HTTPS') return 'HTTPS'
  if (p === 'SOCKS5' || p === 'SOCKS') return 'SOCKS5'
  return 'HTTP'
}

function parseProxyString(input) {
  const text = String(input || '').trim()
  if (!text) return null

  let protocol = 'HTTP'
  let body = text
  const protoMatch = body.match(/^([a-z0-9]+):\/\//i)
  if (protoMatch) {
    protocol = normalizeProtocol(protoMatch[1])
    body = body.slice(protoMatch[0].length)
  }

  let authPart = ''
  let hostPortPart = body
  const at = body.lastIndexOf('@')
  if (at > 0) {
    authPart = body.slice(0, at)
    hostPortPart = body.slice(at + 1)
  }

  let host = ''
  let port = 0
  const hostPort = hostPortPart.split(':')
  if (hostPort.length >= 2) {
    port = Number(hostPort.pop())
    host = hostPort.join(':').trim()
  }

  let username = ''
  let password = ''
  if (authPart.includes(':')) {
    const authTokens = authPart.split(':')
    username = (authTokens.shift() || '').trim()
    password = authTokens.join(':').trim()
  } else if (authPart) {
    username = authPart.trim()
  }

  if (!host || !port || Number.isNaN(port)) {
    const tokens = body.split(':')
    if (tokens.length >= 2) {
      host = (tokens.shift() || '').trim()
      port = Number(tokens.shift())
      if (tokens.length >= 2) {
        username = tokens.shift().trim()
        password = tokens.join(':').trim()
      }
    }
  }

  if (!host || !port || Number.isNaN(port)) return null

  return {
    protocol,
    host,
    port,
    authEnabled: !!(username || password),
    username,
    password,
  }
}

async function readProxyFromClipboard() {
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText()
      if (text && text.trim()) return text.trim()
    }
  } catch (_error) {}
  return prompt('Dán chuỗi proxy vào đây (host:port:user:pass hoặc user:pass@host:port):', '')?.trim() || ''
}

async function quickPasteAddProxy() {
  const text = await readProxyFromClipboard()
  if (!text) return
  $('addProxyRaw').value = text
  const parsed = parseProxyString(text)
  if (!parsed) {
    alert('Không đọc được proxy. Dạng hỗ trợ: host:port:user:pass hoặc user:pass@host:port')
    return
  }
  $('addProxyEnabled').checked = true
  $('addProxyProtocol').value = parsed.protocol
  $('addProxyHost').value = parsed.host
  $('addProxyPort').value = parsed.port
  $('addProxyAuthEnabled').checked = !!parsed.authEnabled
  $('addProxyUsername').value = parsed.username
  $('addProxyPassword').value = parsed.password
  syncAddProxyUi()
}

async function quickPasteEditProxy() {
  const text = await readProxyFromClipboard()
  if (!text) return
  $('proxyRaw').value = text
  const parsed = parseProxyString(text)
  if (!parsed) {
    $('proxyCheckResult').textContent = 'Không đọc được proxy từ chuỗi dán.'
    return
  }
  $('proxyEnabled').checked = true
  $('proxyProtocol').value = parsed.protocol
  $('proxyHost').value = parsed.host
  $('proxyPort').value = parsed.port
  $('proxyAuthEnabled').checked = !!parsed.authEnabled
  $('proxyUsername').value = parsed.username
  $('proxyPassword').value = parsed.password
  syncProxyUi()
  $('proxyCheckResult').textContent = 'Đã dán nhanh proxy.'
}

function proxyLabel(proxy) {
  const p = proxy || {}
  if (!p.enabled || !p.host || !p.port) return 'Proxy: Tắt'
  const auth = p.authEnabled && p.username ? ' (auth)' : ''
  return `Proxy: ${p.protocol || 'HTTP'} ${p.host}:${p.port}${auth}`
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 'Z'
  return (words[0][0] + (words[1]?.[0] || '')).toUpperCase()
}

function switchTab(tab) {
  document.querySelectorAll('.main-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`))
  if (tab === 'cloud') refreshCloudStatus().catch(() => {})
}

async function refresh() {
  setStatus('Đang tải danh sách...')
  const rs = await window.api.listProfiles()
  if (!rs || !rs.ok) {
    setStatus('Không tải được danh sách profile')
    return
  }
  profiles = rs.profiles || []
  renderProfiles()
  setStatus(`Đã tải ${profiles.length} profile`)
}

function renderProfiles() {
  const list = $('accountList')
  $('listCount').textContent = `Danh sách (${profiles.length})`
  if (!profiles.length) {
    list.innerHTML = '<div class="empty-state">Chưa có profile nào. Bấm THÊM ZALO để tạo mới.</div>'
    return
  }

  list.innerHTML = profiles.map((p) => {
    const z = p.zUuid || ''
    const short = z ? `${z.slice(0, 16)}...` : 'chưa có z_uuid'
    return `<div class="account-row">
      <div class="acc-avatar">${esc(initials(p.displayName))}</div>
      <div>
        <div class="acc-name">${esc(p.displayName)}</div>
        <div class="acc-meta">${esc(short)} • ${esc(proxyLabel(p.proxy || {}))}</div>
      </div>
      <div class="acc-actions">
        <button class="acc-btn" data-act="open" data-name="${esc(p.profileName)}">Mở</button>
        <button class="acc-btn" data-act="info" data-name="${esc(p.profileName)}">Info</button>
        <button class="acc-btn" data-act="check-proxy" data-name="${esc(p.profileName)}">Check</button>
        <button class="acc-btn" data-act="proxy" data-name="${esc(p.profileName)}">Proxy</button>
        <button class="acc-btn" data-act="export" data-name="${esc(p.profileName)}">Xuất</button>
        <button class="acc-btn" data-act="privacy" data-name="${esc(p.profileName)}">Riêng tư</button>
        <button class="acc-btn" data-act="delete" data-name="${esc(p.profileName)}">Xóa</button>
      </div>
    </div>`
  }).join('')
}

function renderCloud() {
  // Tab cloud: chỉ hiển thị trạng thái dựa trên cloudSyncStatus
}

async function refreshCloudStatus() {
  const el = $('cloudStatusText')
  if (el) el.textContent = 'Đang kiểm tra…'
  try {
    const rs = await window.api.cloudSyncStatus()
    if (!rs.ok) {
      if (el) el.textContent = rs.message || 'Chưa kích hoạt license.'
    } else if (rs.hasBackup) {
      const d = rs.uploadedAt ? new Date(rs.uploadedAt).toLocaleString('vi-VN') : '?'
      if (el) el.textContent = `Có backup ${rs.profileCount} profile — cập nhật lúc ${d}`
    } else {
      if (el) el.textContent = 'Chưa có backup nào trên cloud.'
    }
  } catch (err) {
    if (el) el.textContent = 'Lỗi: ' + (err?.message || 'unknown')
  }
}

async function handleCloudUpload() {
  const btn = $('btnCloudUpload')
  if (btn) { btn.disabled = true; btn.textContent = 'Đang tải lên…' }
  setStatus('Đang upload profiles lên cloud…')
  try {
    const rs = await window.api.cloudSyncUpload()
    if (rs.ok) {
      setStatus(`Đã upload ${rs.profileCount} profile lên cloud.`)
    } else {
      setStatus('Lỗi upload: ' + (rs.message || 'unknown'))
    }
    await refreshCloudStatus()
  } catch (err) {
    setStatus('Lỗi: ' + (err?.message || 'unknown'))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Tải lên' }
  }
}

async function handleCloudDownload() {
  const btn = $('btnCloudDownload')
  if (btn) { btn.disabled = true; btn.textContent = 'Đang đồng bộ…' }
  setStatus('Đang tải profiles từ cloud về…')
  try {
    const rs = await window.api.cloudSyncDownload()
    if (rs.ok) {
      setStatus(`Đã đồng bộ ${rs.imported} profile về máy này.`)
      await refresh()
    } else {
      setStatus('Lỗi download: ' + (rs.message || 'unknown'))
    }
    await refreshCloudStatus()
  } catch (err) {
    setStatus('Lỗi: ' + (err?.message || 'unknown'))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Đồng bộ về' }
  }
}

function openAddModal() {
  $('inputDisplayName').value = `Zalo Web ${profiles.length + 1}`
  $('addProxyRaw').value = ''
  $('addProxyEnabled').checked = false
  $('addProxyProtocol').value = 'HTTP'
  $('addProxyHost').value = ''
  $('addProxyPort').value = ''
  $('addProxyAuthEnabled').checked = false
  $('addProxyUsername').value = ''
  $('addProxyPassword').value = ''
  syncAddProxyUi()
  $('modalOverlay').classList.remove('hidden')
  $('inputDisplayName').focus()
}

function closeAddModal() {
  $('modalOverlay').classList.add('hidden')
}

function syncAddProxyUi() {
  $('addProxyFields').classList.toggle('hidden', !$('addProxyEnabled').checked)
  $('addProxyAuthFields').classList.toggle('hidden', !$('addProxyAuthEnabled').checked)
}

function collectAddProxy() {
  const enabled = $('addProxyEnabled').checked
  if (!enabled) return { enabled: false }
  const raw = $('addProxyRaw').value.trim()
  if (raw) {
    const parsed = parseProxyString(raw)
    if (!parsed) return { enabled: true, host: '', port: 0 }
    $('addProxyProtocol').value = parsed.protocol
    $('addProxyHost').value = parsed.host
    $('addProxyPort').value = String(parsed.port)
    $('addProxyAuthEnabled').checked = !!parsed.authEnabled
    $('addProxyUsername').value = parsed.username
    $('addProxyPassword').value = parsed.password
    syncAddProxyUi()
  }
  return {
    enabled: true,
    protocol: $('addProxyProtocol').value,
    host: $('addProxyHost').value.trim(),
    port: Number($('addProxyPort').value || 0),
    authEnabled: $('addProxyAuthEnabled').checked,
    username: $('addProxyUsername').value.trim(),
    password: $('addProxyPassword').value,
  }
}

async function handleAdd() {
  const name = $('inputDisplayName').value.trim() || `Zalo Web ${profiles.length + 1}`
  const proxy = collectAddProxy()
  if (proxy.enabled && (!proxy.host || !proxy.port)) {
    alert('Proxy thiếu host hoặc port')
    return
  }
  setStatus('Đang tạo profile...')
  const rs = await window.api.addProfile(name, proxy)
  if (!rs || !rs.ok) {
    alert('Tạo profile thất bại: ' + (rs?.message || 'unknown'))
    setStatus('Tạo profile thất bại')
    return
  }
  closeAddModal()
  await refresh()
}

async function handleImport() {
  setStatus('Đang nhập JSON...')
  const rs = await window.api.importProfile()
  if (!rs || !rs.ok) {
    if (rs?.message === 'Đã huỷ') {
      setStatus('Đã huỷ nhập')
      return
    }
    alert('Nhập thất bại: ' + (rs?.message || 'unknown'))
    setStatus('Nhập thất bại')
    return
  }
  await refresh()
}

function renderBackupList() {
  const box = $('backupList')
  if (!box) return
  if (!profiles.length) {
    box.innerHTML = '<div class="empty-state" style="padding:16px">Chưa có profile để sao lưu.</div>'
    return
  }
  box.innerHTML = profiles.map((p) => {
    const checked = backupSelected.has(p.profileName) ? 'checked' : ''
    return `<label class="backup-item">
      <input type="checkbox" data-backup-name="${esc(p.profileName)}" ${checked} />
      <span class="backup-item-name">${esc(p.displayName)}</span>
    </label>`
  }).join('')
}

function openBackupModal() {
  if (!profiles.length) {
    alert('Chưa có profile để sao lưu')
    return
  }
  backupSelected = new Set(profiles.map((p) => p.profileName))
  renderBackupList()
  $('backupOverlay').classList.remove('hidden')
}

function closeBackupModal() {
  $('backupOverlay').classList.add('hidden')
}

async function handleExportSelected() {
  const selected = [...backupSelected]
  if (!selected.length) {
    alert('Bạn chưa chọn profile nào')
    return
  }
  setStatus('Đang sao lưu profile đã chọn...')
  const rs = await window.api.exportProfiles(selected)
  if (!rs || !rs.ok) {
    if (rs?.message !== 'Đã huỷ') alert('Sao lưu thất bại: ' + (rs?.message || 'unknown'))
    setStatus('Sao lưu thất bại')
    return
  }
  closeBackupModal()
  setStatus(`Đã sao lưu và xoá ${rs.count || selected.length} profile`)
  await refresh()
}

async function handleListAction(event) {
  const btn = event.target.closest('button[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  const profileName = btn.dataset.name
  if (!act || !profileName) return

  if (act === 'open') {
    setStatus('Đang mở profile...')
    const rs = await window.api.openProfile(profileName)
    if (!rs || !rs.ok) alert('Mở profile thất bại: ' + (rs?.message || 'unknown'))
    setStatus('Sẵn sàng')
    return
  }

  if (act === 'proxy') {
    const target = profiles.find((p) => p.profileName === profileName)
    if (target) openProxyModal(target)
    return
  }

  if (act === 'info') {
    await openProfileInfoModal(profileName)
    return
  }

  if (act === 'check-proxy') {
    const target = profiles.find((p) => p.profileName === profileName)
    const proxy = target?.proxy || {}
    if (!proxy.enabled) {
      alert('Profile này đang tắt proxy')
      return
    }
    setStatus('Đang kiểm tra proxy...')
    const rs = await window.api.checkProxy(proxy)
    if (rs?.ok) alert(`Proxy live: ${rs.ip || 'ok'}`)
    else alert(`Proxy lỗi: ${rs?.message || 'Không hoạt động'}`)
    setStatus('Sẵn sàng')
    return
  }

  if (act === 'export') {
    setStatus('Đang xuất profile...')
    const rs = await window.api.exportProfile(profileName)
    if (!rs || !rs.ok) {
      if (rs?.message !== 'Đã huỷ') alert('Xuất profile thất bại: ' + (rs?.message || 'unknown'))
    } else {
      setStatus(`Đã xuất và xoá profile: ${profileName}`)
      await refresh()
    }
    return
  }

  if (act === 'privacy') {
    await openPrivacyModal(profileName)
    return
  }

  if (act === 'delete') {
    if (!confirm('Xóa profile này?')) return
    setStatus('Đang xóa profile...')
    const rs = await window.api.deleteProfile(profileName)
    if (!rs || !rs.ok) alert('Xóa thất bại: ' + (rs?.message || 'unknown'))
    await refresh()
  }
}

async function openProfileInfoModal(profileName) {
  const rs = await window.api.getProfileInfo(profileName)
  if (!rs || !rs.ok) {
    alert('Không lấy được thông tin profile: ' + (rs?.message || 'unknown'))
    return
  }
  const info = rs.info || {}
  currentProfileInfoJson = JSON.stringify(info, null, 2)
  $('profileInfoContent').textContent = currentProfileInfoJson
  $('profileInfoOverlay').classList.remove('hidden')
}

function closeProfileInfoModal() {
  $('profileInfoOverlay').classList.add('hidden')
}

async function copyProfileInfoJson() {
  if (!currentProfileInfoJson) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(currentProfileInfoJson)
      setStatus('Đã copy JSON thông tin profile')
      return
    }
  } catch (_error) {}
  alert('Trình duyệt không cho phép copy tự động. Bạn có thể chọn tay trong khung JSON.')
}

function openProxyModal(profile) {
  proxyTarget = profile.profileName
  const p = profile.proxy || {}
  $('proxyRaw').value = ''
  $('proxyProfileName').textContent = `Profile: ${profile.displayName}`
  $('proxyEnabled').checked = !!p.enabled
  $('proxyProtocol').value = p.protocol || 'HTTP'
  $('proxyHost').value = p.host || ''
  $('proxyPort').value = p.port || ''
  $('proxyAuthEnabled').checked = !!p.authEnabled
  $('proxyUsername').value = p.username || ''
  $('proxyPassword').value = p.password || ''
  $('proxyCheckResult').textContent = ''
  syncProxyUi()
  $('proxyOverlay').classList.remove('hidden')
}

function closeProxyModal() {
  proxyTarget = null
  $('proxyOverlay').classList.add('hidden')
}

function syncProxyUi() {
  $('proxyFields').classList.toggle('hidden', !$('proxyEnabled').checked)
  $('proxyAuthFields').classList.toggle('hidden', !$('proxyAuthEnabled').checked)
}

function collectProxyFromEdit() {
  const enabled = $('proxyEnabled').checked
  if (!enabled) return { enabled: false }
  const raw = $('proxyRaw').value.trim()
  if (raw) {
    const parsed = parseProxyString(raw)
    if (!parsed) return { enabled: true, host: '', port: 0 }
    $('proxyProtocol').value = parsed.protocol
    $('proxyHost').value = parsed.host
    $('proxyPort').value = String(parsed.port)
    $('proxyAuthEnabled').checked = !!parsed.authEnabled
    $('proxyUsername').value = parsed.username
    $('proxyPassword').value = parsed.password
    syncProxyUi()
  }
  return {
    enabled: true,
    protocol: $('proxyProtocol').value,
    host: $('proxyHost').value.trim(),
    port: Number($('proxyPort').value || 0),
    authEnabled: $('proxyAuthEnabled').checked,
    username: $('proxyUsername').value.trim(),
    password: $('proxyPassword').value,
  }
}

async function handleProxySave() {
  if (!proxyTarget) return
  const proxy = collectProxyFromEdit()
  if (proxy.enabled && (!proxy.host || !proxy.port)) {
    alert('Proxy thiếu host hoặc port')
    return
  }
  const rs = await window.api.updateProxy(proxyTarget, proxy)
  if (!rs || !rs.ok) {
    alert('Lưu proxy thất bại: ' + (rs?.message || 'unknown'))
    return
  }
  closeProxyModal()
  await refresh()
}

async function handleProxyCheck() {
  const proxy = collectProxyFromEdit()
  if (!proxy.enabled) {
    $('proxyCheckResult').textContent = 'Proxy đang tắt.'
    return
  }
  if (!proxy.host || !proxy.port) {
    $('proxyCheckResult').textContent = 'Thiếu host hoặc port.'
    return
  }
  $('proxyCheckResult').textContent = 'Đang kiểm tra...'
  const rs = await window.api.checkProxy(proxy)
  if (rs?.ok) $('proxyCheckResult').textContent = `✅ Live - IP: ${rs.ip || 'ok'}`
  else $('proxyCheckResult').textContent = `❌ ${rs?.message || 'Proxy không hoạt động'}`
}

async function bindSettings() {
  const rs = await window.api.getSettings()
  const settings = rs?.settings || {}
  const pairs = [
    ['chkHideTyping', 'hideTyping'],
    ['chkHideSeen', 'hideSeen'],
    ['chkHideReceived', 'hideReceived'],
  ]

  for (const [id, key] of pairs) {
    const el = $(id)
    if (!el) continue
    el.checked = !!settings[key]
    el.addEventListener('change', async () => {
      await window.api.setSetting(key, !!el.checked)
    })
  }
}

async function refreshHealth() {
  const rs = await window.api.getSystemHealth()
  if (!rs || !rs.ok) {
    $('healthSummary').textContent = 'Không lấy được trạng thái'
    return
  }
  const info = rs.info || {}
  $('healthSummary').textContent = `OK • ${info.profileCount || 0} profile web • app ${info.appVersion || 'v2'}`
}

function licenseStatusLabel(status) {
  const key = String(status || '').toLowerCase()
  if (key === 'active') return 'Đang hoạt động'
  if (key === 'expired') return 'Đã hết hạn'
  if (key === 'kicked') return 'Đã bị đăng nhập ở máy khác'
  return 'Chưa kích hoạt'
}

function formatLicenseDate(iso) {
  if (!iso) return '--/--/----'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('vi-VN')
}

function renderHeaderLicenseBadge(state, runtime) {
  const box = $('appLicenseBadge')
  const title = $('appLicenseBadgeTitle')
  const sub = $('appLicenseBadgeSub')
  if (!box || !title || !sub) return

  const st = state || {}
  const rt = runtime || {}
  const status = String(st.status || '').toLowerCase()
  const isFree = String(rt.quotaSource || '') === 'free'

  box.classList.remove('is-active', 'is-free', 'is-expired', 'is-kicked', 'is-unknown')

  if (status === 'active' && !isFree) {
    box.classList.add('is-active')
    title.textContent = 'LICENSE ACTIVE'
    sub.textContent = `Hết hạn: ${formatLicenseDate(st.licenseExpiresAt)}`
    return
  }

  if (status === 'expired') {
    box.classList.add('is-expired')
    title.textContent = 'LICENSE EXPIRED'
    sub.textContent = `Hết hạn: ${formatLicenseDate(st.licenseExpiresAt)}`
    return
  }

  if (status === 'kicked') {
    box.classList.add('is-kicked')
    title.textContent = 'KICKED'
    sub.textContent = 'Đăng nhập ở máy khác'
    return
  }

  if (isFree || !status) {
    box.classList.add('is-free')
    title.textContent = 'FREE'
    sub.textContent = 'Quota: 1 profile'
    return
  }

  box.classList.add('is-unknown')
  title.textContent = 'LICENSE'
  sub.textContent = `Trạng thái: ${licenseStatusLabel(st.status)}`
}

function renderLicenseState(state, runtime) {
  const st = state || {}
  const rt = runtime || {}
  const effectiveQuota = Number(rt.effectiveQuota || st.accountQuota || 0)
  const quotaLabel = effectiveQuota > 0 ? String(effectiveQuota) : 'Không giới hạn'
  const quotaMode = String(rt.quotaSource || '') === 'free' ? ' (gói miễn phí)' : ''
  const summary = [
    `Trạng thái: ${licenseStatusLabel(st.status)}`,
    `Yêu cầu license: ${rt.requireLicense ? 'Có' : 'Không'}`,
    `Quota: ${quotaLabel}${quotaMode}`,
    `Session: ${st.sessionId || '-'}`,
    `Hết hạn license: ${st.licenseExpiresAt || '-'}`,
    `Heartbeat gần nhất: ${st.lastHeartbeatAt || '-'}`,
  ]
  $('licenseSummary').textContent = summary.join(' • ')
  renderHeaderLicenseBadge(st, rt)
}

async function refreshLicenseStatus() {
  const rs = await window.api.getLicenseStatus()
  if (!rs || !rs.ok) {
    $('licenseSummary').textContent = 'Không lấy được trạng thái license.'
    renderHeaderLicenseBadge({}, {})
    return
  }
  renderLicenseState(rs.state || {}, rs)
}

async function handleLicenseActivate() {
  const key = $('licenseKeyInput').value.trim()
  if (!key) {
    alert('Nhập key kích hoạt trước')
    return
  }
  setStatus('Đang kích hoạt license...')
  const rs = await window.api.activateLicense(key)
  if (!rs || !rs.ok) {
    alert('Kích hoạt thất bại: ' + (rs?.message || 'unknown'))
    setStatus('Kích hoạt thất bại')
    return
  }
  $('licenseKeyInput').value = ''
  await refreshLicenseStatus()
  setStatus('Kích hoạt license thành công')
}

async function handleLicenseHeartbeat() {
  setStatus('Đang heartbeat license...')
  const rs = await window.api.heartbeatLicense()
  if (!rs || !rs.ok) {
    alert('Heartbeat báo lỗi: ' + (rs?.message || rs?.status || 'unknown'))
  }
  await refreshLicenseStatus()
  setStatus('Sẵn sàng')
}

async function handleLicenseDeactivate() {
  if (!confirm('Gỡ kích hoạt license trên máy này?')) return
  const rs = await window.api.deactivateLicense()
  if (!rs || !rs.ok) {
    alert('Không gỡ được license: ' + (rs?.message || 'unknown'))
    return
  }
  await refreshLicenseStatus()
}

function bind() {
  document.querySelectorAll('.main-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })

  $('btnClose').addEventListener('click', () => window.api.closeWindow())
  $('btnMinimize').addEventListener('click', () => window.api.minimizeWindow())
  $('btnAddAccount').addEventListener('click', openAddModal)
  $('modalClose').addEventListener('click', closeAddModal)
  $('modalCancel').addEventListener('click', closeAddModal)
  $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeAddModal() })
  $('btnModalAdd').addEventListener('click', handleAdd)
  $('addProxyEnabled').addEventListener('change', syncAddProxyUi)
  $('addProxyAuthEnabled').addEventListener('change', syncAddProxyUi)
  $('addProxyRaw').addEventListener('blur', () => {
    const parsed = parseProxyString($('addProxyRaw').value.trim())
    if (!parsed) return
    $('addProxyEnabled').checked = true
    $('addProxyProtocol').value = parsed.protocol
    $('addProxyHost').value = parsed.host
    $('addProxyPort').value = String(parsed.port)
    $('addProxyAuthEnabled').checked = !!parsed.authEnabled
    $('addProxyUsername').value = parsed.username
    $('addProxyPassword').value = parsed.password
    syncAddProxyUi()
  })
  $('addProxyQuickPaste').addEventListener('click', () => { quickPasteAddProxy().catch(() => {}) })

  $('btnImport').addEventListener('click', handleImport)
  $('btnExport').addEventListener('click', openBackupModal)
  $('btnLaunchAll').addEventListener('click', async () => {
    setStatus('Đang mở tất cả profile...')
    const rs = await window.api.launchAll()
    setStatus(rs?.message || 'Đã mở tất cả')
  })
  $('btnOpenFolder').addEventListener('click', () => window.api.openProfilesFolder())
  $('toolOpenFolder').addEventListener('click', () => window.api.openProfilesFolder())
  $('toolLaunchAll').addEventListener('click', async () => {
    const rs = await window.api.launchAll()
    setStatus(rs?.message || 'Đã mở tất cả')
  })
  $('toolImport').addEventListener('click', handleImport)
  $('toolExport').addEventListener('click', openBackupModal)
  $('btnCloudRefresh').addEventListener('click', () => refreshCloudStatus().catch(() => {}))
  $('btnCloudUpload').addEventListener('click', () => handleCloudUpload().catch(() => {}))
  $('btnCloudDownload').addEventListener('click', () => handleCloudDownload().catch(() => {}))
  $('btnHealthRefresh').addEventListener('click', () => refreshHealth())
  $('accountList').addEventListener('click', handleListAction)

  $('btnLicenseActivate').addEventListener('click', () => { handleLicenseActivate().catch(() => {}) })
  $('btnLicenseHeartbeat').addEventListener('click', () => { handleLicenseHeartbeat().catch(() => {}) })
  $('btnLicenseRefresh').addEventListener('click', () => { refreshLicenseStatus().catch(() => {}) })
  $('btnLicenseDeactivate').addEventListener('click', () => { handleLicenseDeactivate().catch(() => {}) })

  $('proxyClose').addEventListener('click', closeProxyModal)
  $('proxyCancel').addEventListener('click', closeProxyModal)
  $('proxyOverlay').addEventListener('click', (e) => { if (e.target === $('proxyOverlay')) closeProxyModal() })
  $('proxyEnabled').addEventListener('change', syncProxyUi)
  $('proxyAuthEnabled').addEventListener('change', syncProxyUi)
  $('proxyRaw').addEventListener('blur', () => {
    const parsed = parseProxyString($('proxyRaw').value.trim())
    if (!parsed) return
    $('proxyEnabled').checked = true
    $('proxyProtocol').value = parsed.protocol
    $('proxyHost').value = parsed.host
    $('proxyPort').value = String(parsed.port)
    $('proxyAuthEnabled').checked = !!parsed.authEnabled
    $('proxyUsername').value = parsed.username
    $('proxyPassword').value = parsed.password
    syncProxyUi()
  })
  $('proxyQuickPaste').addEventListener('click', () => { quickPasteEditProxy().catch(() => {}) })
  $('proxySave').addEventListener('click', handleProxySave)
  $('proxyCheck').addEventListener('click', handleProxyCheck)

  $('backupClose').addEventListener('click', closeBackupModal)
  $('backupCancel').addEventListener('click', closeBackupModal)
  $('backupOverlay').addEventListener('click', (e) => { if (e.target === $('backupOverlay')) closeBackupModal() })
  $('backupList').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-backup-name]')
    if (!input) return
    const profileName = input.dataset.backupName
    if (!profileName) return
    if (input.checked) backupSelected.add(profileName)
    else backupSelected.delete(profileName)
  })
  $('backupSelectAll').addEventListener('click', () => {
    backupSelected = new Set(profiles.map((p) => p.profileName))
    renderBackupList()
  })
  $('backupClearAll').addEventListener('click', () => {
    backupSelected = new Set()
    renderBackupList()
  })
  $('backupConfirm').addEventListener('click', handleExportSelected)

  $('profileInfoClose').addEventListener('click', closeProfileInfoModal)
  $('profileInfoOk').addEventListener('click', closeProfileInfoModal)
  $('profileInfoCopy').addEventListener('click', () => { copyProfileInfoJson().catch(() => {}) })
  $('profileInfoOverlay').addEventListener('click', (e) => { if (e.target === $('profileInfoOverlay')) closeProfileInfoModal() })

  if (typeof window.api.onProfileUpdated === 'function') {
    window.api.onProfileUpdated(() => { refresh().catch(() => {}) })
  }

  if (typeof window.api.onProfilesReloaded === 'function') {
    window.api.onProfilesReloaded(() => { refresh().catch(() => {}) })
  }

  if (typeof window.api.onLicenseUpdated === 'function') {
    window.api.onLicenseUpdated(() => {
      refreshLicenseStatus().catch(() => {})
    })
  }
}

bind()
bindSettings().catch(() => {})
refresh().catch(() => setStatus('Lỗi khởi tạo'))
refreshHealth().catch(() => {})
refreshLicenseStatus().catch(() => {})

/* ---------- Auto-update UI ---------- */
let _updateAvailable = null

function showUpdateModal(info) {
  if (info) _updateAvailable = info
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
  try {
    const dl = await window.api.updateDownload()
    if (!dl || !dl.ok) {
      $('updateStatus').textContent = 'Lỗi: ' + ((dl && dl.message) || 'không tải được')
      confirm.disabled = false
      return
    }
    $('updateStatus').textContent = 'Tải xong. Đang chạy installer, app sẽ tắt...'
    const ins = await window.api.updateInstall()
    if (!ins || !ins.ok) {
      $('updateStatus').textContent = 'Lỗi cài đặt: ' + ((ins && ins.message) || 'unknown')
      confirm.disabled = false
    }
  } catch (error) {
    $('updateStatus').textContent = 'Lỗi: ' + (error && error.message ? error.message : String(error))
    confirm.disabled = false
  }
}

function bindUpdate() {
  const pill = $('updatePill')
  if (pill) pill.addEventListener('click', () => showUpdateModal())
  const close = $('updateClose')
  if (close) close.addEventListener('click', hideUpdateModal)
  const later = $('updateLater')
  if (later) later.addEventListener('click', hideUpdateModal)
  const confirm = $('updateConfirm')
  if (confirm) confirm.addEventListener('click', () => handleUpdateConfirm().catch(() => {}))

  if (typeof window.api.onUpdateAvailable === 'function') {
    window.api.onUpdateAvailable((info) => {
      _updateAvailable = info
      const pillEl = $('updatePill')
      if (pillEl) {
        pillEl.classList.remove('hidden')
        pillEl.title = 'Bản ' + (info.remoteVersion || '?') + ' đã sẵn sàng'
      }
      showUpdateModal(info)
    })
  }
  if (typeof window.api.onUpdateProgress === 'function') {
    window.api.onUpdateProgress((info) => {
      const pct = Math.round((info.percent || 0) * 100)
      $('updateBarFill').style.width = pct + '%'
      const mb = (n) => Math.round((n || 0) / 1024 / 1024)
      $('updateProgressText').textContent = pct + '% (' + mb(info.received) + ' / ' + mb(info.total) + ' MB)'
    })
  }

  // Force a foreground check at startup so users don't need to wait for
  // the background timer before seeing update availability.
  if (typeof window.api.updateCheck === 'function') {
    window.api.updateCheck().then((rs) => {
      if (!rs || !rs.ok || !rs.hasUpdate) return
      _updateAvailable = rs
      const pillEl = $('updatePill')
      if (pillEl) {
        pillEl.classList.remove('hidden')
        pillEl.title = 'Bản ' + (rs.remoteVersion || '?') + ' đã sẵn sàng'
      }
      showUpdateModal(rs)
    }).catch(() => {})
  }
}

/* ---------- License kicked dialog ---------- */
function bindLicenseKicked() {
  const close = $('licenseKickedClose')
  const ok = $('licenseKickedOk')
  const overlay = $('licenseKickedOverlay')
  const hide = () => { if (overlay) overlay.classList.add('hidden') }
  if (close) close.addEventListener('click', hide)
  if (ok) ok.addEventListener('click', hide)

  if (typeof window.api.onLicenseKicked === 'function') {
    window.api.onLicenseKicked((info) => {
      const msg = (info && info.message) || 'License đã bị thu hồi.'
      const sub = info?.status === 'kicked'
        ? 'Profiles của bạn đã được tự động sao lưu lên cloud. Đăng nhập lại trên máy kia và chọn "Đồng bộ về" để lấy dữ liệu.'
        : ''
      const target = $('licenseKickedMessage')
      if (target) target.textContent = msg + (sub ? '\n' + sub : '')
      if (overlay) overlay.classList.remove('hidden')
      refreshLicenseStatus().catch(() => {})
      refreshCloudStatus().catch(() => {})
    })
  }
}

bindUpdate()
bindLicenseKicked()

/* ---------- Per-profile privacy modal ---------- */

let _privacyTarget = null

async function openPrivacyModal(profileName) {
  _privacyTarget = profileName
  const nameEl = $('privacyProfileName')
  if (nameEl) nameEl.textContent = profileName
  $('privacyOverlay').classList.remove('hidden')
  ;['privHideTyping', 'privHideSeen', 'privHideReceived'].forEach((id) => {
    const el = $(id)
    if (el) { el.disabled = true; el.checked = false }
  })
  try {
    const rs = await window.api.getProfilePrivacy(profileName)
    if (!rs || !rs.ok) {
      alert('Không lấy được cấu hình riêng tư: ' + ((rs && rs.message) || 'unknown'))
      closePrivacyModal()
      return
    }
    const p = rs.privacy || {}
    ;[['privHideTyping', 'hideTyping'], ['privHideSeen', 'hideSeen'], ['privHideReceived', 'hideReceived']]
      .forEach(([id, key]) => {
        const el = $(id)
        if (!el) return
        el.disabled = false
        el.checked = !!p[key]
      })
  } catch (err) {
    alert('Lỗi: ' + (err && err.message ? err.message : 'unknown'))
    closePrivacyModal()
  }
}

function closePrivacyModal() {
  $('privacyOverlay').classList.add('hidden')
  _privacyTarget = null
}

async function handlePrivacyToggle(key, value) {
  if (!_privacyTarget) return
  const rs = await window.api.setProfilePrivacy(_privacyTarget, key, value)
  if (!rs || !rs.ok) {
    alert('Lưu thất bại: ' + ((rs && rs.message) || 'unknown'))
    const idMap = { hideTyping: 'privHideTyping', hideSeen: 'privHideSeen', hideReceived: 'privHideReceived' }
    const el = $(idMap[key])
    if (el) el.checked = !value
    return
  }
  setStatus(_privacyTarget + ': ' + key + ' = ' + (value ? 'ON' : 'OFF'))
}

function bindPrivacyModal() {
  const close = $('privacyClose')
  if (close) close.addEventListener('click', closePrivacyModal)
  const done = $('privacyDone')
  if (done) done.addEventListener('click', closePrivacyModal)
  const overlay = $('privacyOverlay')
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closePrivacyModal() })
  ;[['privHideTyping', 'hideTyping'], ['privHideSeen', 'hideSeen'], ['privHideReceived', 'hideReceived']]
    .forEach(([id, key]) => {
      const el = $(id)
      if (el) el.addEventListener('change', () => handlePrivacyToggle(key, el.checked))
    })
}

bindPrivacyModal()
