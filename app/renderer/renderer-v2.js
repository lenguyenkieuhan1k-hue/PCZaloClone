const $ = (id) => document.getElementById(id)
let profiles = []
let proxyTarget = null
let renameTarget = null
let backupSelected = new Set()
let bulkPickSelected = new Set()
let currentProfileInfoJson = ''
let refreshTimer = null
let refreshInFlight = false
let refreshPending = false
/** Nếu có refresh xếp hàng sau một lần silent, lần chạy tiếp theo vẫn im lặng (tránh nháy status). */
let refreshQueuedSilent = false
let licenseRefreshInFlight = false
let licenseRefreshPending = false
let delayedUpdateCheckTimer = null
let addProfileInFlight = false

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ---------------------------------------------------------------------------
 * Frameless BrowserWindow + Windows DWM/Chromium: một số bản Electron/OS
 * gặp ô nhập “đơ” cho tới khi repaint (minimize hoặc chụp màn hình có thể hết).
 *
 * Chiến lược nhẹ — không gọi resizeHack từ main trong lúc gõ modal (xem cảnh báo
 * trong main.v2.js → nudgeMainWindowComposite):
 *   - IPC `nudge-composite` → webContents.invalidate() (preload: nudgeComposite).
 *   - Sau khi bỏ class `hidden` trên overlay modal: afterModalSurfaceShown() + focus ô.
 *   - Mọi `input.field-input` / `select.field-input` (kể cả ô license trên tab Cài đặt):
 *     focus + input debounce → invalidate (delegation, không cần liệt kê từng id).
 * -------------------------------------------------------------------------- */

const MODAL_COMPOSITE_NUDGE_MS = 180
let modalCompositeNudgeTimer = null

function requestMainWindowRepaint() {
  window.setTimeout(() => {
    try {
      if (typeof window.api?.nudgeComposite === 'function') window.api.nudgeComposite().catch(() => {})
    } catch (_) {}
  }, 60)
}

function nudgeCompositeLight() {
  try {
    if (typeof window.api?.nudgeComposite === 'function') window.api.nudgeComposite().catch(() => {})
  } catch (_) {}
}

/** Gọi sau khi modal overlay hiện (trước hoặc sau focus tùy luồng). */
function afterModalSurfaceShown() {
  nudgeCompositeLight()
  requestMainWindowRepaint()
}

function scheduleModalCompositeNudgeDebounced() {
  if (modalCompositeNudgeTimer) window.clearTimeout(modalCompositeNudgeTimer)
  modalCompositeNudgeTimer = window.setTimeout(() => {
    modalCompositeNudgeTimer = null
    nudgeCompositeLight()
  }, MODAL_COMPOSITE_NUDGE_MS)
}

function bindModalCompositeWorkaroundInputs() {
  const shouldNudge = (el) => {
    if (!el || typeof el.matches !== 'function') return false
    return el.matches('input.field-input, select.field-input, textarea.field-input')
  }
  document.addEventListener(
    'focusin',
    (e) => {
      if (shouldNudge(e.target)) nudgeCompositeLight()
    },
    true,
  )
  document.addEventListener(
    'input',
    (e) => {
      if (shouldNudge(e.target)) scheduleModalCompositeNudgeDebounced()
    },
    true,
  )
}

/** Chỉ các modal có ô nhập / chọn nhiều — tránh flicker thanh trạng thái khi tương tác form */
function statusBarPausedByTypingModal() {
  const ids = ['modalOverlay', 'proxyOverlay', 'renameOverlay', 'backupOverlay', 'privacyOverlay']
  return ids.some((id) => {
    const el = $(id)
    return !!el && !el.classList.contains('hidden')
  })
}

/** Focus đang ở ô nhập liệu (tab Cài đặt, v.v.) — tránh IPC + render làm giật caret */
function isTypingInField() {
  const el = document.activeElement
  if (!el || !el.tagName) return false
  const t = el.tagName.toLowerCase()
  if (t === 'textarea') return true
  if (t === 'select') return true
  if (t === 'input') {
    const type = String(el.type || 'text').toLowerCase()
    if (['button', 'submit', 'checkbox', 'radio', 'file', 'hidden', 'reset', 'image'].includes(type)) return false
    return true
  }
  return false
}

function shouldDeferRefresh() {
  return isModalOpen() || isTypingInField()
}

function setStatus(text, opts = {}) {
  const force = !!opts.force
  if (!force && statusBarPausedByTypingModal()) return
  $('statusBar').textContent = text || 'Sẵn sàng'
}

function fileBasename(fullPath) {
  const s = String(fullPath || '').trim().replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function showToast(message, type = 'info', duration = 4300) {
  const container = $('toastContainer')
  if (!container || !message) return
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.textContent = message
  toast.addEventListener('click', () => toast.remove())
  container.appendChild(toast)
  window.setTimeout(() => toast.remove(), duration)
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

  let host = ''
  let port = 0
  let username = ''
  let password = ''

  const at = body.lastIndexOf('@')
  if (at > 0) {
    const authPart = body.slice(0, at)
    const hostPortPart = body.slice(at + 1)

    const hostPort = hostPortPart.split(':')
    if (hostPort.length >= 2) {
      port = Number(hostPort.pop())
      host = hostPort.join(':').trim()
    }

    if (authPart.includes(':')) {
      const authTokens = authPart.split(':')
      username = (authTokens.shift() || '').trim()
      password = authTokens.join(':').trim()
    } else {
      username = authPart.trim()
    }
  } else {
    const tokens = body.split(':')
    if (tokens.length >= 2) {
      host = (tokens.shift() || '').trim()
      port = Number(tokens.shift())
      if (tokens.length >= 1) {
        username = (tokens.shift() || '').trim()
        password = tokens.join(':').trim()
      }
    }
  }

  if (!host || Number.isNaN(port) || port < 1 || port > 65535) return null

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

async function refresh(options = {}) {
  const wantSilent = !!options.silent
  // Không gọi listProfiles (IPC) khi đang modal / gõ ô nhập — tránh lag và giật focus
  if (shouldDeferRefresh()) {
    refreshPending = true
    if (wantSilent) refreshQueuedSilent = true
    return
  }
  if (refreshInFlight) {
    refreshPending = true
    if (wantSilent) refreshQueuedSilent = true
    return
  }
  refreshInFlight = true
  const runSilent = wantSilent || refreshQueuedSilent
  refreshQueuedSilent = false
  if (!runSilent) setStatus('Đang tải danh sách...')
  try {
    const rs = await window.api.listProfiles()
    if (!rs || !rs.ok) {
      setStatus('Không tải được danh sách profile')
      return
    }
    profiles = rs.profiles || []

    if (shouldDeferRefresh()) {
      refreshPending = true
      if (runSilent) refreshQueuedSilent = true
      return
    }

    renderProfiles()
    if (!runSilent) setStatus(`Đã tải ${profiles.length} profile`)
  } finally {
    refreshInFlight = false
    if (refreshPending && !shouldDeferRefresh()) {
      refreshPending = false
      const chainSilent = refreshQueuedSilent
      refreshQueuedSilent = false
      void refresh({ silent: chainSilent })
    }
  }
}

function isModalOpen() {
  const modalIds = ['modalOverlay', 'proxyOverlay', 'backupOverlay', 'renameOverlay', 'privacyOverlay', 'updateOverlay', 'licenseKickedOverlay']
  return modalIds.some((id) => {
    const el = $(id)
    return !!el && !el.classList.contains('hidden')
  })
}

function focusModalInput(id) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id)
    if (!el || typeof el.focus !== 'function') return
    try {
      el.focus({ preventScroll: true })
    } catch (_) {
      el.focus()
    }
  })
}

/** Click dark backdrop đóng một số modal (không áp dụng Thêm Zalo / Đổi tên — giống nhau: chỉ X / Hủy / Esc). */
function setupModalBackdropDismiss() {
  document.addEventListener('click', (e) => {
    const t = e.target
    if (!t?.classList?.contains('modal-overlay')) return
    const overlay = t
    if (overlay.id === 'proxyOverlay' && !overlay.classList.contains('hidden')) closeProxyModal()
    else if (overlay.id === 'backupOverlay' && !overlay.classList.contains('hidden')) closeBackupModal()
  })
}

function scheduleRefresh(options = {}) {
  const allowDuringModal = !!options.allowDuringModal
  if (!allowDuringModal && shouldDeferRefresh()) {
    refreshPending = true
    return
  }
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 260)
}

function pruneBulkPickToExisting() {
  const names = new Set(profiles.map((p) => p.profileName))
  for (const n of [...bulkPickSelected]) {
    if (!names.has(n)) bulkPickSelected.delete(n)
  }
}

function syncBulkMasterCheckbox() {
  const master = $('chkBulkMaster')
  if (!master) return
  const total = profiles.length
  const n = bulkPickSelected.size
  if (!total) {
    master.checked = false
    master.indeterminate = false
    return
  }
  master.indeterminate = n > 0 && n < total
  master.checked = n === total
}

function updateBulkSelectionHint() {
  const el = $('bulkSelectionHint')
  if (!el) return
  const n = bulkPickSelected.size
  el.textContent = n ? `Đã chọn ${n}` : ''
}

function handleAccountListBulkChange(e) {
  const inp = e.target.closest('input[data-bulk-name]')
  if (!inp) return
  const name = String(inp.dataset.bulkName || '').trim()
  if (!name) return
  if (inp.checked) bulkPickSelected.add(name)
  else bulkPickSelected.delete(name)
  syncBulkMasterCheckbox()
  updateBulkSelectionHint()
}

async function handleBulkExportRows() {
  const selected = [...bulkPickSelected]
  if (!selected.length) {
    alert('Chưa chọn profile nào trong danh sách (ô bên trái).')
    return
  }
  const gst = await window.api.getSettings()
  const deleteAfter = gst?.settings?.deleteProfileAfterExport !== false
  if (deleteAfter) {
    if (
      !confirm(
        `Sau khi lưu file .zmb, ${selected.length} profile sẽ bị XÓA khỏi máy này. Chỉ còn dữ liệu trong file đã chọn. Tiếp tục?`,
      )
    ) {
      return
    }
  }
  setStatus('Đang xuất profile đã chọn…', { force: true })
  try {
    const rs = await window.api.exportProfiles(selected, { deleteAfterExport: deleteAfter })
    if (!rs || !rs.ok) {
      if (rs?.message !== 'Đã huỷ') {
        const msg = rs?.message || 'Xuất thất bại'
        showToast(msg, 'error', 6500)
        setStatus(msg, { force: true })
      } else {
        setStatus('Đã huỷ xuất', { force: true })
      }
      return
    }
    const base = rs.filePath ? fileBasename(rs.filePath) : ''
    const n = rs.count || selected.length
    const okMsg = base ? `Đã lưu file "${base}" (${n} profile).` : `Đã xuất ${n} profile.`
    setStatus(okMsg, { force: true })
    showToast(okMsg, 'success', 6500)
    const del = Array.isArray(rs.deletedProfiles) ? rs.deletedProfiles : []
    const delFail = Array.isArray(rs.profilesDeleteFailed) ? rs.profilesDeleteFailed : []
    if (del.length) {
      showToast(`Đã xóa ${del.length} profile khỏi máy (theo tùy chọn).`, 'info', 6500)
    }
    if (delFail.length) {
      const lines = delFail.map((x) => `${x.profileName}: ${x.message || 'lỗi'}`).join('\n')
      showToast(`File đã lưu nhưng không xóa hết profile: ${delFail.length} lỗi.`, 'error', 10000)
      alert(`File sao lưu đã lưu xong, nhưng xóa profile sau xuất gặp lỗi:\n${lines}`)
    }
    const missingKey = Array.isArray(rs.profilesMissingCookieKey) ? rs.profilesMissingCookieKey : []
    if (missingKey.length) {
      const elevated = !!rs.exportElevated
      showToast(
        elevated
          ? `Đã lưu file nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. ZaloMask đang chạy với quyền Administrator — thoát hẳn app và mở lại bình thường (KHÔNG chọn "Run as administrator"), rồi xuất lại để sang máy khác giữ phiên.`
          : `Đã lưu nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. Sang máy khác thường phải đăng nhập lại — đóng Zalo trước khi xuất; nếu vẫn lỗi, phiên Zalo có thể dùng mã hoá App-Bound (không hỗ trợ xuất khóa kiểu cũ).`,
        'info',
        16000,
      )
    }
    bulkPickSelected.clear()
    await refresh()
  } catch (err) {
    const msg = err?.message || 'Lỗi xuất'
    showToast(msg, 'error', 6500)
    setStatus(msg, { force: true })
  }
}

async function handleBulkDeleteRows() {
  const selected = [...bulkPickSelected]
  if (!selected.length) {
    alert('Chưa chọn profile nào trong danh sách.')
    return
  }
  if (!confirm(`Xóa vĩnh viễn ${selected.length} profile khỏi máy? Thao tác không hoàn tác.`)) return
  setStatus(`Đang xóa ${selected.length} profile…`, { force: true })
  for (const profileName of selected) {
    const rs = await window.api.deleteProfile(profileName)
    if (!rs || !rs.ok) {
      const msg = rs?.message || 'unknown'
      showToast(`${profileName}: ${msg}`, 'error', 5500)
    }
  }
  bulkPickSelected.clear()
  showToast('Đã gửi lệnh xóa các profile đã chọn.', 'info', 5000)
  setStatus('Đã gửi lệnh xóa profile', { force: true })
  await refresh()
}

function renderProfiles() {
  const list = $('accountList')
  $('listCount').textContent = `Danh sách (${profiles.length})`
  pruneBulkPickToExisting()
  if (!profiles.length) {
    list.innerHTML = '<div class="empty-state">Chưa có profile nào. Bấm THÊM ZALO để tạo mới.</div>'
    bulkPickSelected.clear()
    updateBulkSelectionHint()
    syncBulkMasterCheckbox()
    return
  }

  list.innerHTML = profiles
    .map((p) => {
      const z = p.zUuid || ''
      const short = z ? `${z.slice(0, 16)}...` : 'chưa có z_uuid'
      const bulkOn = bulkPickSelected.has(p.profileName) ? 'checked' : ''
      return `<div class="account-row">
      <label class="col-pick acc-pick">
        <input type="checkbox" data-bulk-name="${esc(p.profileName)}" ${bulkOn} aria-label="Chọn ${esc(p.displayName)}" />
      </label>
      <div class="acc-avatar">${esc(initials(p.displayName))}</div>
      <div>
        <div class="acc-name">${esc(p.displayName)}</div>
        <div class="acc-meta">${esc(short)} • ${esc(proxyLabel(p.proxy || {}))}</div>
      </div>
      <div class="acc-actions">
        <button type="button" class="acc-btn" data-act="open" data-name="${esc(p.profileName)}">Mở</button>
        <button type="button" class="acc-btn" data-act="check-proxy" data-name="${esc(p.profileName)}">Check</button>
        <button type="button" class="acc-btn" data-act="proxy" data-name="${esc(p.profileName)}">Proxy</button>
        <button type="button" class="acc-btn" data-act="rename" data-name="${esc(p.profileName)}">Đổi tên</button>
        <button type="button" class="acc-btn" data-act="export" data-name="${esc(p.profileName)}">Xuất</button>
        <button type="button" class="acc-btn" data-act="privacy" data-name="${esc(p.profileName)}">Riêng tư</button>
        <button type="button" class="acc-btn" data-act="delete" data-name="${esc(p.profileName)}">Xóa</button>
      </div>
    </div>`
    })
    .join('')
  syncBulkMasterCheckbox()
  updateBulkSelectionHint()
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
  setStatus('Đang upload profiles lên cloud…', { force: true })
  try {
    const rs = await window.api.cloudSyncUpload()
    if (rs.ok) {
      const msg = `Đã upload ${rs.profileCount} profile lên cloud.`
      setStatus(msg, { force: true })
      showToast(msg, 'success', 5500)
    } else {
      const msg = rs.message || 'unknown'
      setStatus('Lỗi upload: ' + msg, { force: true })
      showToast('Upload cloud thất bại: ' + msg, 'error', 6500)
    }
    await refreshCloudStatus()
  } catch (err) {
    const msg = err?.message || 'unknown'
    setStatus('Lỗi: ' + msg, { force: true })
    showToast('Upload cloud lỗi: ' + msg, 'error', 6500)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Tải lên' }
  }
}

async function handleCloudDownload() {
  const btn = $('btnCloudDownload')
  if (btn) { btn.disabled = true; btn.textContent = 'Đang đồng bộ…' }
  setStatus('Đang tải profiles từ cloud về…', { force: true })
  try {
    const rs = await window.api.cloudSyncDownload()
    if (rs.ok) {
      const msg = `Đã đồng bộ ${rs.imported} profile về máy này.`
      setStatus(msg, { force: true })
      showToast(msg, 'success', 5500)
      await refresh()
    } else {
      const emsg = rs.message || 'unknown'
      setStatus('Lỗi download: ' + emsg, { force: true })
      showToast('Đồng bộ về thất bại: ' + emsg, 'error', 6500)
    }
    await refreshCloudStatus()
  } catch (err) {
    const msg = err?.message || 'unknown'
    setStatus('Lỗi: ' + msg, { force: true })
    showToast('Đồng bộ về lỗi: ' + msg, 'error', 6500)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Đồng bộ về' }
  }
}

function openAddModal() {
  $('inputDisplayName').value = `Zalo PC ${profiles.length + 1}`
  $('addProxyRaw').value = ''
  $('addProxyEnabled').checked = false
  $('addProxyProtocol').value = 'HTTP'
  $('addProxyHost').value = ''
  $('addProxyPort').value = ''
  $('addProxyAuthEnabled').checked = false
  $('addProxyUsername').value = ''
  $('addProxyPassword').value = ''
  $('addProxyCheckResult').textContent = ''
  syncAddProxyUi()
  $('modalOverlay').classList.remove('hidden')
  afterModalSurfaceShown()
  focusModalInput('inputDisplayName')
}

function closeAddModal() {
  $('modalOverlay').classList.add('hidden')
  if (refreshPending) scheduleRefresh({ allowDuringModal: true })
  requestMainWindowRepaint()
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
  if (addProfileInFlight) return
  addProfileInFlight = true
  const addBtn = $('btnModalAdd')
  const cancelBtn = $('modalCancel')
  const closeBtn = $('modalClose')
  try {
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Đang tạo…' }
    if (cancelBtn) cancelBtn.disabled = true
    if (closeBtn) closeBtn.disabled = true

  const name = $('inputDisplayName').value.trim() || `Zalo PC ${profiles.length + 1}`
  const proxy = collectAddProxy()
  if (proxy.enabled && (!proxy.host || !proxy.port)) {
    alert('Proxy thiếu host hoặc port')
    return
  }
  try {
    const rtRs = await window.api.cloneRuntimeStatus()
    const rt = rtRs?.status || {}
    if (!rtRs?.ok || !rt.ok) {
      const msg = rt.message || rtRs?.message || 'unknown'
      alert('Runtime Zalo PC chưa sẵn sàng: ' + msg)
      setStatus('Runtime chưa sẵn sàng', { force: true })
      showToast('Runtime chưa sẵn sàng', 'error', 5000)
      return
    }
  } catch (e) {
    alert('Không kiểm tra được runtime: ' + (e?.message || 'unknown'))
    setStatus('Lỗi kiểm tra runtime', { force: true })
    showToast('Không kiểm tra được runtime', 'error', 5000)
    return
  }
  // Always PC mode — Zalo runtime bundled inside app
  const launchMode = 'pc'
  setStatus('Đang tạo profile…', { force: true })
  const rs = await window.api.addProfile(name, proxy, launchMode)
  if (!rs || !rs.ok) {
    const msg = rs?.message || 'unknown'
    alert('Tạo profile thất bại: ' + msg)
    setStatus('Tạo profile thất bại', { force: true })
    showToast('Tạo profile thất bại: ' + msg, 'error', 5500)
    return
  }
  closeAddModal()
  showToast('Đã tạo profile mới', 'success')
  setStatus('Đã tạo profile mới', { force: true })
  await refresh()
  } finally {
    addProfileInFlight = false
    // If modal is still open (e.g. validation error), re-enable controls.
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'THÊM' }
    if (cancelBtn) cancelBtn.disabled = false
    if (closeBtn) closeBtn.disabled = false
  }
}

async function handleAddProxyCheck() {
  const proxy = collectAddProxy()
  if (!proxy.enabled) {
    $('addProxyCheckResult').textContent = 'Proxy đang tắt.'
    return
  }
  if (!proxy.host || !proxy.port) {
    $('addProxyCheckResult').textContent = 'Thiếu host hoặc port.'
    return
  }
  $('addProxyCheckResult').textContent = 'Đang kiểm tra...'
  const rs = await window.api.checkProxy(proxy)
  if (rs?.ok) $('addProxyCheckResult').textContent = `✅ Live - IP: ${rs.ip || 'ok'}`
  else $('addProxyCheckResult').textContent = `❌ ${rs?.message || 'Proxy không hoạt động'}`
}

async function handleImport() {
  setStatus('Đang nhập package/profile…', { force: true })
  const rs = await window.api.importProfile()
  if (!rs || !rs.ok) {
    if (rs?.message === 'Đã huỷ') {
      setStatus('Đã huỷ nhập', { force: true })
      return
    }
    const msg = rs?.message || 'unknown'
    alert('Nhập thất bại: ' + msg)
    setStatus('Nhập thất bại', { force: true })
    showToast('Nhập thất bại: ' + msg, 'error', 6500)
    return
  }
  const checks = Array.isArray(rs.restoreChecks) ? rs.restoreChecks : []
  const verifyWarnings = Array.isArray(rs.verifyWarnings) ? rs.verifyWarnings : []
  if (checks.length > 0) {
    const lines = checks.map((item) => {
      const status = item.likelyRestored ? 'OK' : 'CAN KIEM TRA LAI'
      let line = `${item.profileName}: ${status} (checklist ${item.score || 0}%)`
      const h = Array.isArray(item.hints) ? item.hints.filter(Boolean) : []
      if (h.length) line += `\n  • ${h.join('\n  • ')}`
      return line
    })
    const warningText = verifyWarnings.length > 0
      ? `\n\nLưu ý: ${verifyWarnings.length} tệp runtime biến động (log/lock/journal) lệch checksum/size đã được bỏ qua an toàn.`
      : ''
    const scoreNote = '\n\n— % “checklist” = tỷ lệ các mục kiểm tra file trên đĩa (ZaloData/Cookies/LevelDB…), không phải % dữ liệu đã copy.\n— Sang máy khác mà bị đăng nhập lại chủ yếu do khóa cookie (DPAPI): cần file xuất có cookieKey và máy đích áp DPAPI thành công (xem gợi ý phía trên).'
    alert(`Kết quả khôi phục:\n- ${lines.join('\n- ')}${warningText}${scoreNote}`)
    const weakCount = checks.filter((x) => !x.likelyRestored).length
    if (weakCount > 0) {
      setStatus(`Đã nhập ${checks.length} profile, ${weakCount} profile cần kiểm tra đăng nhập`, { force: true })
    } else {
      setStatus(`Đã nhập ${checks.length} profile, dữ liệu khôi phục tốt`, { force: true })
    }
  }
  showToast('Nhập profile thành công', 'success')
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

function setBackupModalBusy(busy, msg = '', opts = {}) {
  const hint = $('backupActionHint')
  const err = !!opts.error
  if (hint) {
    if (!busy && !msg) {
      hint.textContent = ''
      hint.classList.add('hidden')
      hint.classList.remove('is-error')
    } else if (msg) {
      hint.textContent = msg
      hint.classList.remove('hidden')
      hint.classList.toggle('is-error', err)
    }
  }
  const btn = $('backupConfirm')
  if (btn) {
    btn.disabled = !!busy
    btn.textContent = busy ? 'Đang sao lưu…' : 'SAO LƯU'
  }
  ;['backupCancel', 'backupClose', 'backupSelectAll', 'backupClearAll'].forEach((id) => {
    const el = $(id)
    if (el) el.disabled = !!busy
  })
  document.querySelectorAll('#backupList input[type="checkbox"]').forEach((el) => {
    el.disabled = !!busy
  })
  const bdd = $('chkBackupDeleteAfter')
  if (bdd) bdd.disabled = !!busy
}

async function openBackupModal() {
  if (!profiles.length) {
    alert('Chưa có profile để sao lưu')
    return
  }
  try {
    const rs = await window.api.getSettings()
    const chk = $('chkBackupDeleteAfter')
    if (chk) chk.checked = !!(rs?.settings?.deleteProfileAfterExport)
  } catch (_) {
    const chk = $('chkBackupDeleteAfter')
    if (chk) chk.checked = true
  }
  setBackupModalBusy(false)
  backupSelected = new Set(profiles.map((p) => p.profileName))
  renderBackupList()
  $('backupOverlay').classList.remove('hidden')
}

function closeBackupModal() {
  $('backupOverlay').classList.add('hidden')
  if (refreshPending) scheduleRefresh({ allowDuringModal: true })
  requestMainWindowRepaint()
}

function openRenameModal(profileName) {
  const p = profiles.find((x) => x.profileName === profileName)
  if (!p) return
  renameTarget = profileName
  $('renameProfileHint').textContent = `Mã thư mục nội bộ (không đổi): ${profileName}`
  $('renameDisplayName').value = p.displayName || profileName
  $('renameOverlay').classList.remove('hidden')
  afterModalSurfaceShown()
  focusModalInput('renameDisplayName')
}

function closeRenameModal() {
  renameTarget = null
  $('renameOverlay').classList.add('hidden')
  if (refreshPending) scheduleRefresh({ allowDuringModal: true })
  requestMainWindowRepaint()
}

async function handleRenameSave() {
  if (!renameTarget) return
  const displayName = $('renameDisplayName').value.trim()
  if (!displayName) {
    alert('Nhập tên hiển thị')
    return
  }
  if (typeof window.api.renameProfile !== 'function') {
    alert('Bản app này chưa hỗ trợ đổi tên')
    return
  }
  const rs = await window.api.renameProfile(renameTarget, displayName)
  if (!rs?.ok) {
    alert(rs?.message || 'Đổi tên thất bại')
    return
  }
  closeRenameModal()
  setStatus('Đã đổi tên hiển thị')
  showToast('Đã đổi tên hiển thị', 'success')
  await refresh()
}

async function handleExportSelected() {
  const selected = [...backupSelected]
  if (!selected.length) {
    alert('Bạn chưa chọn profile nào')
    return
  }
  const deleteAfter = !!$('chkBackupDeleteAfter')?.checked
  if (deleteAfter) {
    const n = selected.length
    if (
      !confirm(
        `Sau khi lưu file .zmb, ${n} profile sẽ bị XÓA khỏi máy này. Chỉ còn dữ liệu trong file đã chọn. Tiếp tục?`,
      )
    ) {
      return
    }
  }
  setBackupModalBusy(true, 'Đang đóng gói… Có thể mất vài giây (đang tắt Zalo profile nếu đang chạy).')
  setStatus('Đang sao lưu profile đã chọn…', { force: true })
  try {
    const rs = await window.api.exportProfiles(selected, { deleteAfterExport: deleteAfter })
    if (!rs || !rs.ok) {
      const cancelled = rs?.message === 'Đã huỷ'
      if (!cancelled) {
        const msg = rs?.message || 'Sao lưu thất bại'
        setBackupModalBusy(false, msg, { error: true })
        showToast(msg, 'error', 6500)
        setStatus(msg, { force: true })
      } else {
        setBackupModalBusy(false)
        setStatus('Đã huỷ sao lưu', { force: true })
      }
      return
    }
    const base = rs.filePath ? fileBasename(rs.filePath) : ''
    const n = rs.count || selected.length
    const okMsg = base
      ? `Đã lưu file "${base}" (${n} profile).`
      : `Đã sao lưu ${n} profile.`
    const del = Array.isArray(rs.deletedProfiles) ? rs.deletedProfiles : []
    const delFail = Array.isArray(rs.profilesDeleteFailed) ? rs.profilesDeleteFailed : []
    setBackupModalBusy(false)
    closeBackupModal()
    setStatus(okMsg, { force: true })
    showToast(okMsg, 'success', 6500)
    if (del.length) {
      showToast(`Đã xóa ${del.length} profile khỏi máy (theo tùy chọn).`, 'info', 6500)
    }
    if (delFail.length) {
      const lines = delFail.map((x) => `${x.profileName}: ${x.message || 'lỗi'}`).join('\n')
      showToast(`File đã lưu nhưng không xóa hết profile: ${delFail.length} lỗi.`, 'error', 10000)
      alert(`File sao lưu đã lưu xong, nhưng xóa profile sau xuất gặp lỗi:\n${lines}`)
    }
    const missingKey = Array.isArray(rs.profilesMissingCookieKey) ? rs.profilesMissingCookieKey : []
    if (missingKey.length) {
      const elevated = !!rs.exportElevated
      showToast(
        elevated
          ? `Đã lưu file nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. ZaloMask đang chạy với quyền Administrator — thoát hẳn app và mở lại bình thường (KHÔNG chọn "Run as administrator"), rồi xuất lại để sang máy khác giữ phiên.`
          : `Đã lưu nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. Sang máy khác thường phải đăng nhập lại — đóng Zalo trước khi xuất; nếu vẫn lỗi, phiên Zalo có thể dùng mã hoá App-Bound (không hỗ trợ xuất khóa kiểu cũ).`,
        'info',
        16000,
      )
    }
    await refresh()
  } catch (err) {
    const msg = err?.message || 'Lỗi không xác định khi sao lưu'
    setBackupModalBusy(false, msg, { error: true })
    showToast(msg, 'error', 6500)
    setStatus(msg, { force: true })
  }
}

async function handleListAction(event) {
  const btn = event.target.closest('button[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  const profileName = btn.dataset.name
  if (!act || !profileName) return

  if (act === 'open') {
    setStatus('Đang mở profile…', { force: true })
    const rs = await window.api.openProfile(profileName)
    if (!rs || !rs.ok) {
      const msg = rs?.message || 'unknown'
      alert('Mở profile thất bại: ' + msg)
      showToast('Mở profile thất bại', 'error', 5000)
      setStatus('Mở profile thất bại', { force: true })
    } else {
      let toastMsg = 'Đã mở Zalo cho profile này'
      let toastKind = 'success'
      let toastDur = 4500
      if (rs.proxyFallback?.mode === 'url-auth') {
        toastMsg = 'Đã mở Zalo (proxy bridge lỗi — dùng xác thực URL thay thế, vẫn qua proxy)'
        toastKind = 'warning'
        toastDur = 6500
      } else if (rs.alreadyRunning) {
        toastMsg = 'Profile đang mở — đã đưa cửa sổ Zalo ra trước'
      }
      showToast(toastMsg, toastKind, toastDur)
      setStatus('Đã mở profile', { force: true })
      await refresh()
    }
    return
  }

  if (act === 'proxy') {
    const target = profiles.find((p) => p.profileName === profileName)
    if (target) openProxyModal(target)
    return
  }

  if (act === 'rename') {
    openRenameModal(profileName)
    return
  }

  if (act === 'check-proxy') {
    const target = profiles.find((p) => p.profileName === profileName)
    const proxy = target?.proxy || {}
    if (!proxy.enabled) {
      alert('Profile này đang tắt proxy')
      return
    }
    setStatus('Đang kiểm tra proxy…', { force: true })
    const rs = await window.api.checkProxy(proxy)
    if (rs?.ok) {
      const msg = `Proxy hoạt động — IP: ${rs.ip || 'ok'}`
      alert(`Proxy live: ${rs.ip || 'ok'}`)
      showToast(msg, 'success', 4500)
      setStatus(msg, { force: true })
    } else {
      const msg = rs?.message || 'Không hoạt động'
      alert(`Proxy lỗi: ${msg}`)
      showToast('Proxy không qua được kiểm tra', 'error', 5500)
      setStatus('Proxy lỗi: ' + msg, { force: true })
    }
    return
  }

  if (act === 'export') {
    const gst = await window.api.getSettings()
    const deleteAfter = gst?.settings?.deleteProfileAfterExport !== false
    if (deleteAfter) {
      if (
        !confirm(
          'Sau khi lưu file .zmb, profile này sẽ bị XÓA khỏi máy. Chỉ còn trong file đã chọn. Tiếp tục?',
        )
      ) {
        setStatus('Đã huỷ xuất', { force: true })
        return
      }
    }
    setStatus('Đang xuất profile…', { force: true })
    const rs = await window.api.exportProfile(profileName, { deleteAfterExport: deleteAfter })
    if (!rs || !rs.ok) {
      if (rs?.message !== 'Đã huỷ') {
        const msg = rs?.message || 'unknown'
        alert('Xuất profile thất bại: ' + msg)
        showToast('Xuất thất bại: ' + msg, 'error', 6500)
        setStatus('Xuất profile thất bại', { force: true })
      } else {
        setStatus('Đã huỷ xuất', { force: true })
      }
    } else {
      const base = rs.filePath ? fileBasename(rs.filePath) : ''
      const okMsg = base ? `Đã lưu "${base}"` : `Đã xuất profile ${profileName}`
      setStatus(okMsg, { force: true })
      showToast(okMsg, 'success', 6500)
      const del = Array.isArray(rs.deletedProfiles) ? rs.deletedProfiles : []
      const delFail = Array.isArray(rs.profilesDeleteFailed) ? rs.profilesDeleteFailed : []
      if (del.length) {
        showToast('Đã xóa profile khỏi máy (theo tùy chọn Cài đặt).', 'info', 6500)
      }
      if (delFail.length) {
        const x = delFail[0]
        showToast(`Đã lưu file nhưng xóa profile thất bại: ${x?.message || 'lỗi'}`, 'error', 9000)
      }
      const missingKey = Array.isArray(rs.profilesMissingCookieKey) ? rs.profilesMissingCookieKey : []
      if (missingKey.length) {
        const elevated = !!rs.exportElevated
        showToast(
          elevated
            ? `Đã lưu file nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. ZaloMask đang chạy với quyền Administrator — thoát hẳn app và mở lại bình thường (KHÔNG chọn "Run as administrator"), rồi xuất lại để sang máy khác giữ phiên.`
            : `Đã lưu nhưng không trích được khóa cookie cho: ${missingKey.join(', ')}. Sang máy khác thường phải đăng nhập lại — đóng Zalo trước khi xuất; nếu vẫn lỗi, phiên Zalo có thể dùng mã hoá App-Bound (không hỗ trợ xuất khóa kiểu cũ).`,
          'info',
          16000,
        )
      }
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
    setStatus('Đang xóa profile…', { force: true })
    const rs = await window.api.deleteProfile(profileName)
    if (!rs || !rs.ok) {
      const msg = rs?.message || 'unknown'
      alert('Xóa thất bại: ' + msg)
      showToast('Xóa profile thất bại', 'error', 5500)
      setStatus('Xóa thất bại', { force: true })
    } else {
      showToast(rs.pending ? 'Đang xóa profile…' : 'Đã xóa profile', rs.pending ? 'info' : 'success', 5000)
      setStatus(rs.pending ? 'Đang xóa profile (nền)…' : 'Đã xóa profile', { force: true })
    }
    await refresh()
  }
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
  afterModalSurfaceShown()
  if ($('proxyEnabled').checked) {
    focusModalInput('proxyRaw')
  } else {
    window.requestAnimationFrame(() => {
      const sw = $('proxyEnabled')
      if (sw && typeof sw.focus === 'function') {
        try {
          sw.focus()
        } catch (_) {}
      }
    })
  }
}

function closeProxyModal() {
  proxyTarget = null
  $('proxyOverlay').classList.add('hidden')
  if (refreshPending) scheduleRefresh({ allowDuringModal: true })
  requestMainWindowRepaint()
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
    const msg = rs?.message || 'unknown'
    alert('Lưu proxy thất bại: ' + msg)
    showToast('Lưu proxy thất bại', 'error', 5500)
    setStatus('Lưu proxy thất bại', { force: true })
    return
  }
  closeProxyModal()
  showToast('Đã lưu proxy cho profile', 'success', 4500)
  setStatus('Đã cập nhật proxy', { force: true })
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
    ['chkDeleteAfterExport', 'deleteProfileAfterExport'],
  ]

  for (const [id, key] of pairs) {
    const el = $(id)
    if (!el) continue
    el.checked = !!settings[key]
    el.addEventListener('change', async () => {
      await window.api.setSetting(key, !!el.checked)
      if (key === 'deleteProfileAfterExport') {
        const b = $('chkBackupDeleteAfter')
        if (b) b.checked = !!el.checked
      }
    })
  }
}

async function refreshHealth() {
  const rs = await window.api.getSystemHealth()
  let runtimeText = 'Runtime: chưa kiểm tra'
  try {
    const rtRs = await window.api.cloneRuntimeStatus()
    const rt = rtRs?.status || {}
    runtimeText = rt.ok ? 'Runtime: OK' : `Runtime: ${rt.message || 'chưa sẵn sàng'}`
  } catch (_e) {
    runtimeText = 'Runtime: lỗi kiểm tra'
  }
  if (!rs || !rs.ok) {
    $('healthSummary').textContent = `Không lấy được trạng thái • ${runtimeText}`
    return
  }
  const info = rs.info || {}
  $('healthSummary').textContent = `OK • ${info.profileCount || 0} profile PC • app ${info.appVersion || 'v2'} • ${runtimeText}`
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
  if (licenseRefreshInFlight) {
    licenseRefreshPending = true
    return
  }
  licenseRefreshInFlight = true
  const rs = await window.api.getLicenseStatus()
  try {
    if (!rs || !rs.ok) {
      $('licenseSummary').textContent = 'Không lấy được trạng thái license.'
      renderHeaderLicenseBadge({}, {})
      return
    }
    renderLicenseState(rs.state || {}, rs)
  } finally {
    licenseRefreshInFlight = false
    if (licenseRefreshPending) {
      licenseRefreshPending = false
      refreshLicenseStatus().catch(() => {})
    }
  }
}

function scheduleLicenseRefresh() {
  if (licenseRefreshInFlight) {
    licenseRefreshPending = true
    return
  }
  refreshLicenseStatus().catch(() => {})
}

async function handleLicenseActivate() {
  const key = $('licenseKeyInput').value.trim()
  if (!key) {
    alert('Nhập key kích hoạt trước')
    return
  }
  setStatus('Đang kích hoạt license…', { force: true })
  const rs = await window.api.activateLicense(key)
  if (!rs || !rs.ok) {
    const msg = rs?.message || 'unknown'
    alert('Kích hoạt thất bại: ' + msg)
    setStatus('Kích hoạt thất bại', { force: true })
    showToast('Kích hoạt license thất bại', 'error', 5500)
    return
  }
  $('licenseKeyInput').value = ''
  await refreshLicenseStatus()
  setStatus('Kích hoạt license thành công', { force: true })
  showToast('Đã kích hoạt license', 'success', 5000)
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
  bindModalCompositeWorkaroundInputs()
  document.querySelectorAll('.main-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })

  $('btnClose').addEventListener('click', () => window.api.closeWindow())
  $('btnMinimize').addEventListener('click', () => window.api.minimizeWindow())
  $('btnAddAccount').addEventListener('click', openAddModal)
  $('modalClose').addEventListener('click', closeAddModal)
  $('modalCancel').addEventListener('click', closeAddModal)
  // Do NOT preventDefault on overlay mousedown - it blocks focus into inputs
  // and causes the "modal feels frozen" bug. Let mouse events propagate normally.
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
  $('addProxyCheck').addEventListener('click', () => { handleAddProxyCheck().catch(() => {}) })

  $('btnImport').addEventListener('click', handleImport)
  $('btnExport').addEventListener('click', () => {
    openBackupModal().catch(() => {})
  })
  $('btnLaunchAll').addEventListener('click', async () => {
    setStatus('Đang mở tất cả profile…', { force: true })
    const rs = await window.api.launchAll()
    const msg = rs?.message || 'Đã mở tất cả'
    setStatus(msg, { force: true })
    if (rs?.ok !== false) showToast(msg, 'success', 5000)
    else showToast(msg, 'error', 5500)
    await refresh()
  })
  $('btnOpenFolder').addEventListener('click', () => window.api.openProfilesFolder())
  $('toolOpenFolder').addEventListener('click', () => window.api.openProfilesFolder())
  $('toolLaunchAll').addEventListener('click', async () => {
    setStatus('Đang mở tất cả profile…', { force: true })
    const rs = await window.api.launchAll()
    const msg = rs?.message || 'Đã mở tất cả'
    setStatus(msg, { force: true })
    if (rs?.ok !== false) showToast(msg, 'success', 5000)
    else showToast(msg, 'error', 5500)
    await refresh()
  })
  $('toolImport').addEventListener('click', handleImport)
  $('toolExport').addEventListener('click', () => {
    openBackupModal().catch(() => {})
  })
  $('btnCloudRefresh').addEventListener('click', () => refreshCloudStatus().catch(() => {}))
  $('btnCloudUpload').addEventListener('click', () => handleCloudUpload().catch(() => {}))
  $('btnCloudDownload').addEventListener('click', () => handleCloudDownload().catch(() => {}))
  $('btnHealthRefresh').addEventListener('click', () => refreshHealth())
  const btnDiag = $('btnExportDiagnostics')
  if (btnDiag) {
    btnDiag.addEventListener('click', async () => {
      setStatus('Đang gói báo cáo chẩn đoán...', { force: true })
      try {
        const rs = await window.api.exportDiagnostics()
        if (rs?.canceled) {
          setStatus('', { force: true })
          return
        }
        if (rs?.ok && rs.path) {
          showToast(`Đã lưu chẩn đoán: ${rs.path}`, 'success', 6000)
          setStatus('Đã xuất ZIP chẩn đoán', { force: true })
        } else {
          showToast(rs?.message || 'Xuất thất bại', 'error', 6000)
          setStatus(rs?.message || 'Xuất chẩn đoán thất bại', { force: true })
        }
      } catch (e) {
        showToast(e?.message || 'Lỗi', 'error', 5000)
        setStatus('', { force: true })
      }
    })
  }
  $('accountList').addEventListener('click', handleListAction)
  $('accountList').addEventListener('change', handleAccountListBulkChange)

  const bulkMaster = $('chkBulkMaster')
  if (bulkMaster) {
    bulkMaster.addEventListener('change', (e) => {
      const on = e.target.checked
      if (on) profiles.forEach((p) => bulkPickSelected.add(p.profileName))
      else bulkPickSelected.clear()
      renderProfiles()
    })
  }
  const bulkEx = $('btnBulkExportRows')
  if (bulkEx) bulkEx.addEventListener('click', () => handleBulkExportRows().catch(() => {}))
  const bulkDel = $('btnBulkDeleteRows')
  if (bulkDel) bulkDel.addEventListener('click', () => handleBulkDeleteRows().catch(() => {}))

  $('btnLicenseActivate').addEventListener('click', () => { handleLicenseActivate().catch(() => {}) })
  $('btnLicenseHeartbeat').addEventListener('click', () => { handleLicenseHeartbeat().catch(() => {}) })
  $('btnLicenseRefresh').addEventListener('click', () => { refreshLicenseStatus().catch(() => {}) })
  $('btnLicenseDeactivate').addEventListener('click', () => { handleLicenseDeactivate().catch(() => {}) })

  $('proxyClose').addEventListener('click', closeProxyModal)
  $('proxyCancel').addEventListener('click', closeProxyModal)
  // Do NOT preventDefault on overlay mousedown - it blocks focus into inputs.
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

  const bdd = $('chkBackupDeleteAfter')
  if (bdd) {
    bdd.addEventListener('change', async () => {
      await window.api.setSetting('deleteProfileAfterExport', !!bdd.checked)
      const toolsChk = $('chkDeleteAfterExport')
      if (toolsChk) toolsChk.checked = !!bdd.checked
    })
  }

  $('renameClose').addEventListener('click', closeRenameModal)
  $('renameCancel').addEventListener('click', closeRenameModal)
  $('renameSave').addEventListener('click', () => { handleRenameSave().catch(() => {}) })

  if (typeof window.api.onProfileUpdated === 'function') {
    window.api.onProfileUpdated(() => { scheduleRefresh() })
  }

  if (typeof window.api.onProfilesReloaded === 'function') {
    window.api.onProfilesReloaded(() => { scheduleRefresh({ allowDuringModal: true }) })
  }

  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Escape' && e.key !== 'Esc') || !isModalOpen()) return
    e.preventDefault()
    e.stopPropagation()
    if (!$('modalOverlay').classList.contains('hidden')) closeAddModal()
    else if (!$('proxyOverlay').classList.contains('hidden')) closeProxyModal()
    else if (!$('backupOverlay').classList.contains('hidden')) closeBackupModal()
    else if (!$('renameOverlay').classList.contains('hidden')) closeRenameModal()
    else if (!$('privacyOverlay').classList.contains('hidden')) closePrivacyModal()
    else if (!$('updateOverlay').classList.contains('hidden')) hideUpdateModal()
    else if (!$('licenseKickedOverlay').classList.contains('hidden')) {
      $('licenseKickedOverlay').classList.add('hidden')
    }
  }, true)

  setupModalBackdropDismiss()

  document.addEventListener(
    'focusout',
    () => {
      window.setTimeout(() => {
        if (refreshPending && !shouldDeferRefresh()) scheduleRefresh()
      }, 120)
    },
    true,
  )

  if (typeof window.api.onLicenseUpdated === 'function') {
    window.api.onLicenseUpdated(() => { scheduleLicenseRefresh() })
  }

  let bulkVisTimer = null
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const tab = document.querySelector('.main-tab.active')?.dataset?.tab
    if (tab !== 'clone') return
    if (bulkVisTimer) window.clearTimeout(bulkVisTimer)
    bulkVisTimer = window.setTimeout(() => {
      if (!document.hidden) scheduleRefresh()
    }, 350)
  })
}

let rendererDiagForwardingInstalled = false
function installRendererDiagnosticsForwarding() {
  if (rendererDiagForwardingInstalled) return
  rendererDiagForwardingInstalled = true
  const send = (level, message, detail) => {
    try {
      if (typeof window.api?.logToMain === 'function') {
        window.api.logToMain(level, String(message || '').slice(0, 2000), detail)
      }
    } catch (_) {}
  }
  window.addEventListener('error', (ev) => {
    send('error', ev.message || 'window.error', {
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4500) : '',
    })
  })
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason
    const msg = r && typeof r === 'object' && r.message ? r.message : String(r)
    send('unhandledrejection', msg.slice(0, 2000), {
      stack: r && typeof r === 'object' && r.stack ? String(r.stack).slice(0, 4500) : String(r).slice(0, 2000),
    })
  })
}

installRendererDiagnosticsForwarding()
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
  requestMainWindowRepaint()
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

  // Delay the foreground update check to reduce startup churn in the main window.
  if (typeof window.api.updateCheck === 'function') {
    if (delayedUpdateCheckTimer) clearTimeout(delayedUpdateCheckTimer)
    delayedUpdateCheckTimer = setTimeout(() => {
      delayedUpdateCheckTimer = null
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
    }, 15000)
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
  requestMainWindowRepaint()
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindPrivacyModal)
} else {
  // Defer one tick so any late-injected modal HTML lands in DOM first.
  setTimeout(bindPrivacyModal, 0)
}