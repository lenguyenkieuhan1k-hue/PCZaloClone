# AutoZalo Bridge — Quy trình lấy phiên đăng nhập Zalo

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Các thành phần chính](#2-các-thành-phần-chính)
3. [Luồng dữ liệu tổng thể](#3-luồng-dữ-liệu-tổng-thể)
4. [Chi tiết từng bước](#4-chi-tiết-từng-bước)
   - [Bước 1 — Web App kích hoạt đăng nhập](#bước-1--web-app-kích-hoạt-đăng-nhập)
   - [Bước 2 — Background mở cửa sổ Incognito](#bước-2--background-mở-cửa-sổ-incognito)
   - [Bước 3 — zalo-main.js trích xuất dữ liệu](#bước-3--zalo-mainjs-trích-xuất-dữ-liệu-main-world)
   - [Bước 4 — zalo-bridge.js chuyển tiếp dữ liệu](#bước-4--zalo-bridgejs-chuyển-tiếp-dữ-liệu-isolated-world)
   - [Bước 5 — Background đọc Cookies và hoàn tất](#bước-5--background-đọc-cookies-và-hoàn-tất)
   - [Bước 6 — Broadcast về Web App](#bước-6--broadcast-về-web-app)
5. [Cơ chế truyền dữ liệu giữa các world](#5-cơ-chế-truyền-dữ-liệu-giữa-các-world)
6. [Trích xuất Session — Chi tiết kỹ thuật](#6-trích-xuất-session--chi-tiết-kỹ-thuật)
7. [Trích xuất Cookie](#7-trích-xuất-cookie)
8. [WebSocket Interceptor](#8-websocket-interceptor)
9. [Cơ chế Sync State](#9-cơ-chế-sync-state)
10. [Fallback và xử lý lỗi](#10-fallback-và-xử-lý-lỗi)
11. [Tại sao cần 2 content scripts?](#11-tại-sao-cần-2-content-scripts)

---

## 1. Tổng quan kiến trúc

Extension gồm 4 file chính, mỗi file chạy ở một ngữ cảnh khác nhau:

```
┌─────────────────────────────────────────────────────────────────┐
│  manifest.json — Khai báo quyền và cấu hình                      │
├─────────────────────────────────────────────────────────────────┤
│  background.js — Service Worker (MV3)                            │
│  • Quản lý vòng đời incognito window                             │
│  • Điều phối dữ liệu giữa Zalo tab và Web App                   │
│  • Đọc Cookies, gom dữ liệu session                             │
├─────────────────────────────────────────────────────────────────┤
│  content/zalo-main.js — MAIN world, chạy trên chat.zalo.me      │
│  • Truy cập thẳng vào JS nội bộ của Zalo                        │
│  • Trích xuất friends, groups, me, session                      │
│  • Intercept WebSocket realtime                                  │
├─────────────────────────────────────────────────────────────────┤
│  content/zalo-bridge.js — ISOLATED world, chạy trên chat.zalo.me│
│  • Nhận dữ liệu từ zalo-main.js qua CustomEvent                 │
│  • Gửi dữ liệu lên background qua chrome.runtime.sendMessage    │
├─────────────────────────────────────────────────────────────────┤
│  content/web-bridge.js — ISOLATED world, chạy trên Web App      │
│  • Cầu nối giữa trang web frontend và background                 │
└─────────────────────────────────────────────────────────────────┘
```

### Quyền hạn yêu cầu (manifest.json)

| Quyền | Mục đích |
|---|---|
| `cookies` | Đọc toàn bộ cookie `.zalo.me` từ tab incognito |
| `tabs` | Truy vấn, tạo, điều hướng tab |
| `scripting` | Inject script theo yêu cầu động |
| `host_permissions: https://*.zalo.me/*` | Truy cập cookie và inject vào Zalo |

---

## 2. Các thành phần chính

### background.js — Biến trạng thái quan trọng

```js
let webAppTabs          // Set các tabId của Web App đang mở
let incognitoWindowId   // ID cửa sổ incognito đang dùng để đăng nhập
let pendingLoginTabId   // Tab ID trong incognito đang ở chat.zalo.me
let lastKnownLoginData  // Dữ liệu Zalo đã nhận từ content script
let loginCompleted      // Đã hoàn tất đăng nhập thành công chưa
let messageActionTabId  // Tab incognito được giữ lại để gửi tin nhắn
let pendingAccountSync  // Dữ liệu đang chờ xác nhận sync
let syncState           // Trạng thái đồng bộ hiện tại (phase, requestId, ...)
```

### syncState — Chu kỳ trạng thái

```
idle
  → waiting_for_login    (khi mở incognito)
  → awaiting_sync_confirmation  (khi nhận đủ dữ liệu)
  → syncing_account      (khi confirm)
  → ready                (hoàn tất, có thể dùng tài khoản)
  → cancelled / error    (thất bại hoặc hủy)
```

---

## 3. Luồng dữ liệu tổng thể

```
[Web App Frontend]
       │
       │  chrome.runtime.sendMessage("OPEN_ZALO_LOGIN")
       ▼
[background.js]
       │
       │  chrome.windows.create({ incognito: true, url: "https://chat.zalo.me/" })
       ▼
[Incognito Window — chat.zalo.me]
       │
       │  (document_start)
       ▼
[zalo-main.js — MAIN world]
       │  Đợi window.$$afmc.zStorage
       │  Trích xuất: me, friends, groups, session
       │  Monkey-patch WebSocket
       │
       │  CustomEvent("__zalotool__", { type, data })
       ▼
[zalo-bridge.js — ISOLATED world]
       │  Gom đủ: me + friends + groups + session
       │
       │  chrome.runtime.sendMessage("ZALO_DATA_READY", data)
       ▼
[background.js]
       │  chrome.cookies.getAll({ domain: ".zalo.me" })
       │  Gộp: data + cookies → accountData
       │  stagePendingAccountSync(accountData)
       │  ↳ Auto-confirm sau 1500ms
       │  Minimize cửa sổ incognito (giữ lại làm action tab)
       │
       │  chrome.tabs.sendMessage("ZALOTOOL_ACCOUNT_DATA", accountData)
       ▼
[Web App Frontend]
       ✓ Nhận đầy đủ: me, friends, groups, session, cookies
```

---

## 4. Chi tiết từng bước

### Bước 1 — Web App kích hoạt đăng nhập

Web App (frontend) gửi message đến background:

```js
chrome.runtime.sendMessage({
  type: 'OPEN_ZALO_LOGIN',
  data: { mode: 'add' }  // hoặc 'refresh'
})
```

Background kiểm tra origin sender qua `isTrustedWebAppSender()`:
- Tab đã đăng ký trong `webAppTabs` → trusted
- URL khớp với pattern trong `host_permissions` → trusted
- Không khớp → từ chối, trả lỗi

---

### Bước 2 — Background mở cửa sổ Incognito

```js
async function openIncognitoForLogin(payload) {
  await closeIncognito()        // Đóng incognito cũ nếu có
  await delay(300)              // Đợi Chrome clear session cũ
  resetPendingSession()         // Reset toàn bộ state

  const win = await chrome.windows.create({
    url: 'https://chat.zalo.me/',
    incognito: true,
    focused: true,
    width: 1280,
    height: 800,
  })

  incognitoWindowId = win.id
  pendingLoginTabId = win.tabs[0].id
  syncState.phase = 'waiting_for_login'

  scheduleFallbackFinalize()    // Đặt timer fallback 30 giây
}
```

**Tại sao dùng Incognito?**
- Session sạch, không bị lẫn cookie của tài khoản khác đang đăng nhập ở cửa sổ thường.
- Dễ đọc đúng cookie store của tab cần lấy.

---

### Bước 3 — `zalo-main.js` trích xuất dữ liệu (MAIN world)

Script này chạy ở `world: "MAIN"` và `run_at: "document_start"` — nghĩa là nó chạy **cùng JS context với trang Zalo**, có quyền truy cập mọi biến global của Zalo.

#### 3a. Đợi `$$afmc.zStorage` sẵn sàng

```js
var MAX_WAIT = 150         // Tối đa 150 giây (~2.5 phút)
var INITIAL_EXTRACT_DELAY = 2500   // Đợi 2.5s trước lần đầu

// Kiểm tra mỗi 1 giây:
function poll() {
  if (window.$$afmc && window.$$afmc.zStorage) {
    extractAll()
  } else if (attempt < MAX_WAIT) {
    attempt++
    setTimeout(poll, 1000)
  }
}
```

`$$afmc.zStorage` là object nội bộ của Zalo Web chứa dữ liệu đã được giải mã, bao gồm danh sách bạn bè, nhóm, thông tin tài khoản.

#### 3b. Trích xuất Me, Friends, Groups

```js
async function collectSnapshot(zs) {
  // Lấy thông tin tài khoản đang đăng nhập
  const me = await zs.getMe()

  // Lấy danh sách bạn bè
  const friends = await zs.getFriends()

  // Lấy nhóm từ nhiều nguồn (merge lại)
  const groups = await collectGroups(zs)

  return { me, friends, groups }
}
```

**Trích xuất nhóm từ 3 nguồn** (để đảm bảo đầy đủ cho tài khoản nhiều nhóm):

| Nguồn | Hàm | Ghi chú |
|---|---|---|
| zStorage API | `zs.getGroups()` | Có thể thiếu nếu cache chưa đầy đủ |
| IndexedDB | Scan tất cả DB có object store `group` | Nguồn dữ liệu persistent của Zalo |
| Conversations | `zs.getConversations()` | Lọc các conversation dạng group |

Kết quả được **dedup** theo `userId / globalId / displayName`.

#### 3c. Trích xuất Session

Sau khi extraction hoàn tất, init Webpack API Bridge:

```js
function buildSessionSnapshot() {
  // imei — Zalo Client ID (định danh thiết bị)
  const X4fA = _wr('X4fA')
  const imei = X4fA.a.getZaloClientID()

  // userId, UIN, commonParams từ HTTP/Business module
  const sessionSource = _businessModule || _httpModule
  const userId = sessionSource.userId || sessionSource.uid
  const UIN = sessionSource.UIN
  const commonParams = sessionSource._getCommonParams()

  // decryptKey, labelVersion từ localStorage/sessionStorage
  const hints = extractSessionHints()   // Scan toàn bộ storage

  return { imei, userId, UIN, commonParams, decryptKey, ... }
}
```

#### 3d. Webpack API Bridge — Tìm modules nội bộ Zalo

Extension cần truy cập module HTTP và Business của Zalo để gọi API trực tiếp. Tìm qua 3 chiến lược:

**Strategy A — Known hardcoded IDs:**
```js
const knownHttpIds = ['fBUP', 'httpApi', 'http_transport', 'apiTransport']
const knownBizIds  = ['dThN', 'bizService', 'business_logic', 'serviceApi']
// Thử lần lượt qua _wr(id)
```

**Strategy B — Scan webpack module cache (`_wr.c`):**
```js
// Tìm module có hàm getCM() và sendTextMessage()
for (const key of Object.keys(_wr.c)) {
  const mod = _wr.c[key].exports?.default
  if (mod && typeof mod.getCM === 'function') { ... }
}
```

**Strategy C — Scan source code module chưa load (`_wr.m`):**
```js
// Tìm module có source chứa cả getCM và getHistoryMessage
for (const key of Object.keys(_wr.m)) {
  const src = _wr.m[key].toString()
  if (src.includes('getCM') && src.includes('getHistoryMessage')) {
    candidates.push(key)
  }
}
```

#### 3e. Dispatch kết quả về ISOLATED world

```js
function dispatch(type, payload) {
  window.dispatchEvent(new CustomEvent('__zalotool__', {
    detail: JSON.stringify({ type, data: payload })
  }))
}

dispatch('me',      meData)
dispatch('friends', friendsArr)
dispatch('groups',  groupsArr)
dispatch('session', sessionSnapshot)
dispatch('done',    { friends: count, groups: count })
```

---

### Bước 4 — `zalo-bridge.js` chuyển tiếp dữ liệu (ISOLATED world)

```js
var collected = { me: null, friends: null, groups: null, session: null }
var sent = false

window.addEventListener('__zalotool__', function (e) {
  const msg = JSON.parse(e.detail)

  if (msg.type === 'me')      collected.me      = msg.data
  if (msg.type === 'friends') collected.friends = msg.data
  if (msg.type === 'groups')  collected.groups  = msg.data
  if (msg.type === 'session') collected.session = msg.data

  if (msg.type === 'done' && !sent) {
    sent = true
    pushCollectedDataToBackground()
  }
})

function pushCollectedDataToBackground() {
  chrome.runtime.sendMessage({
    type: 'ZALO_DATA_READY',
    data: {
      me:      collected.me,
      friends: collected.friends || [],
      groups:  collected.groups  || [],
      session: collected.session || null,
    }
  })
}
```

---

### Bước 5 — Background đọc Cookies và hoàn tất

#### 5a. Đọc Cookies từ đúng cookie store

```js
async function readZaloCookiesForTab(tabId) {
  // Tìm đúng cookie store của tab incognito
  const stores = await chrome.cookies.getAllCookieStores()
  const senderStore = stores.find(store => store.tabIds.includes(tabId))
  const storeId = senderStore?.id

  // Lấy tất cả cookie domain .zalo.me
  const cookies = await chrome.cookies.getAll({
    domain: '.zalo.me',
    storeId: storeId   // Quan trọng: nếu bỏ storeId sẽ lấy nhầm cookie của profile thường
  })

  return {
    cookieStr:  cookies.map(c => `${c.name}=${c.value}`).join('; '),
    cookieCount: cookies.length,
    cookiesArr: cookies.map(c => ({
      name, value, domain, path, httpOnly, secure, sameSite, expirationDate, session
    }))
  }
}
```

Cookie quan trọng cần lấy bao gồm: `zpw_sek` (session encryption key), `zpsid` (session ID), `app.zalo.me` authentication tokens, v.v.

#### 5b. Gộp toàn bộ thành accountData

```js
const accountData = {
  ...data,              // me, friends, groups, session từ content script
  cookieCount: cookieData.cookieCount,
  cookies:    cookieData.cookiesArr,
  timestamp:  Date.now(),
}
```

#### 5c. Stage pending sync

```js
await stagePendingAccountSync(accountData, windowId)
// → Tạo requestId
// → syncState.phase = 'awaiting_sync_confirmation'
// → Broadcast ZALOTOOL_SYNC_STATE về Web App
// → Đặt timer auto-confirm sau 1500ms
```

#### 5d. Giữ lại cửa sổ Incognito

```js
// Minimize thay vì đóng — cửa sổ này sẽ được dùng để gửi tin nhắn sau
await chrome.windows.update(windowId, { state: 'minimized', focused: false })
messageActionTabId = pendingLoginTabId
```

---

### Bước 6 — Broadcast về Web App

```js
async function confirmAccountSync(requestId) {
  // Chuyển state → syncing_account
  await broadcastSyncState('syncing_account', { requestId, summary })

  // Gửi toàn bộ accountData về tất cả tab Web App
  await broadcastAccountData(pendingAccountSync.accountData)
  //  → chrome.tabs.sendMessage(tabId, { type: 'ZALOTOOL_ACCOUNT_DATA', data: accountData })

  // Chuyển state → ready
  await broadcastSyncState('ready', { summary })
}

async function broadcastToWebApps(type, data) {
  // Re-scan tab mỗi lần broadcast (MV3 service worker có thể restart)
  const allTabs = await chrome.tabs.query({})
  for (const tab of allTabs) {
    if (isTrustedWebAppUrl(tab.url)) webAppTabs.add(tab.id)
  }

  for (const tabId of webAppTabs) {
    await chrome.tabs.sendMessage(tabId, { type, data })
  }
}
```

---

## 5. Cơ chế truyền dữ liệu giữa các world

Chrome Extension có 2 world riêng biệt cho content scripts:

| World | Truy cập JS trang | Truy cập Chrome APIs |
|---|---|---|
| MAIN | ✅ Có | ❌ Không |
| ISOLATED | ❌ Không | ✅ Có |

Vì vậy cần 2 script và 2 kênh giao tiếp:

### MAIN → ISOLATED: CustomEvent

```js
// zalo-main.js (MAIN world) gửi:
window.dispatchEvent(new CustomEvent('__zalotool__', {
  detail: JSON.stringify({ type: 'friends', data: [...] })
}))

// zalo-bridge.js (ISOLATED world) nhận:
window.addEventListener('__zalotool__', handler)
```

### ISOLATED → MAIN: window.postMessage

Khi ISOLATED cần gọi API qua MAIN world (vì chỉ MAIN mới có webpack modules):

```js
// zalo-bridge.js gửi yêu cầu:
window.postMessage({
  source: '__zalotool_api__',
  callId: 'api_123',
  method: 'sendZText',
  args: { toId, message, isGroup }
}, '*')

// zalo-main.js lắng nghe và thực thi:
window.addEventListener('message', function(e) {
  if (e.data.source !== '__zalotool_api__') return
  // Gọi Zalo webpack module
  // Trả kết quả qua CustomEvent '__zalotool_api_result__'
})
```

> **Lý do không dùng CustomEvent cho ISOLATED→MAIN:** `CustomEvent.detail` không vượt qua ranh giới ISOLATED→MAIN trong Chrome Extension. Chỉ `window.postMessage` mới hoạt động hai chiều.

---

## 6. Trích xuất Session — Chi tiết kỹ thuật

Session snapshot cuối cùng chứa:

```js
{
  imei: "...",          // Zalo Client ID (định danh thiết bị ảo)
  userId: "...",        // User ID Zalo
  UIN: "...",           // User Identity Number
  commonParams: "...",  // Query params chung cho mọi API request
  decryptKey: "...",    // AES key để giải mã dữ liệu (từ localStorage)
  labelVersion: null,   // Phiên bản label Zalo
  commonData: {         // Dữ liệu chung cho API calls
    userId, UIN, commonParams
  },
  sessionSource: [...]  // Debug: path nơi tìm thấy key trong storage
}
```

### extractSessionHints() — Scan localStorage/sessionStorage

```js
function extractSessionHints() {
  const target = { decryptKey: '', labelVersion: null, commonData: null }

  // Scan tất cả keys trong cả localStorage và sessionStorage
  [localStorage, sessionStorage].forEach(storage => {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      const value = storage.getItem(key)
      visitCandidateValue(value, `localStorage.${key}`, target, 0)
    }
  })

  return target
}
```

`visitCandidateValue()` đệ quy parse JSON để tìm các trường có dạng AES key hoặc commonParams trong cấu trúc object lồng nhau.

---

## 7. Trích xuất Cookie

### Tại sao cần storeId?

Chrome tách biệt cookie store theo profile và incognito:
- Store `"0"` → profile thường
- Store `"1"` (hoặc khác) → incognito window

Nếu không chỉ định `storeId`, `chrome.cookies.getAll()` trả về cookie của profile mặc định, **không phải** cookie của tab incognito vừa đăng nhập.

```js
const stores = await chrome.cookies.getAllCookieStores()
// stores = [{ id: "0", tabIds: [1, 2, 3] }, { id: "1", tabIds: [99] }]

const senderStore = stores.find(store => store.tabIds.includes(tabId))
// Tìm store chứa tabId của tab incognito
```

### Cấu trúc cookie được lưu

```js
{
  name:           "zpw_sek",
  value:          "...",
  domain:         ".zalo.me",
  path:           "/",
  httpOnly:       true,
  secure:         true,
  sameSite:       "no_restriction",
  expirationDate: 1234567890,
  session:        false
}
```

---

## 8. WebSocket Interceptor

`zalo-main.js` monkey-patch `window.WebSocket` để bắt tin nhắn realtime **ngay khi extension đã có session** (không cần reload):

```js
// Ghi đè WebSocket constructor
window.WebSocket = function ZaloWSInterceptor(url, protocols) {
  const ws = new _OrigWebSocket(url, protocols)

  if (url.includes('zalo.me')) {
    // Intercept .onmessage setter
    Object.defineProperty(ws, 'onmessage', {
      set: fn => {
        origOnMessage = event => {
          const parsed = tryParseWsMessage(event.data)
          if (parsed) handleIncomingWsMessage(parsed.header, parsed.data)
          fn.call(ws, event)  // Luôn pass-through cho Zalo
        }
      }
    })
  }

  return ws
}
```

### Cấu trúc frame WebSocket của Zalo

```
Byte 0:     version (= 1)
Byte 1-3:   cmd (int32 little-endian, thực ra 3 bytes)
Byte 4:     subCmd
Byte 5+:    JSON body (UTF-8)
```

| cmd | Loại |
|---|---|
| `501` | Tin nhắn 1:1 (user-to-user) |
| `521` | Tin nhắn nhóm |

Khi bắt được message hợp lệ → dispatch `CustomEvent('__zalotool__', { type: 'incoming_messages', data: [...] })` → bridge chuyển lên background → broadcast về Web App.

---

## 9. Cơ chế Sync State

Background liên tục broadcast `ZALOTOOL_SYNC_STATE` về Web App để frontend cập nhật UI:

```
idle
  Không có gì đang xảy ra.

waiting_for_login
  Cửa sổ incognito đã mở, đang chờ người dùng đăng nhập.

awaiting_sync_confirmation
  Đã nhận đủ dữ liệu. Đang chờ xác nhận (tự động sau 1.5s).

syncing_account
  Đang ghi dữ liệu vào hệ thống.

ready
  Hoàn tất. Tài khoản có thể sử dụng.

cancelled
  Người dùng hủy hoặc đóng cửa sổ sớm.

error
  Có lỗi xảy ra trong quá trình sync.
```

---

## 10. Fallback và xử lý lỗi

### Fallback 30 giây

Khi mở incognito, background đặt timer 30 giây:

```js
function scheduleFallbackFinalize() {
  pendingFinalizeTimer = setTimeout(() => {
    finalizePendingLogin('timeout')
  }, 30000)
}
```

`finalizePendingLogin()` sẽ:
1. Kiểm tra xem đã có cookie chưa (nếu chưa → reschedule)
2. Dùng `lastKnownLoginData` (dữ liệu từ lần extract cuối cùng, có thể chưa đầy đủ)
3. Vẫn hoàn tất sync với dữ liệu hiện có

### Re-extract (tối đa 4 lần)

Nếu extraction lần đầu thiếu dữ liệu, background yêu cầu bridge thử lại:

```js
function scheduleReextract(tabId, reason) {
  if (pendingReextractCount >= 4) return

  pendingReextractTimer = setTimeout(async () => {
    pendingReextractCount++
    await chrome.tabs.sendMessage(tabId, { type: 'ZALOTOOL_RE_EXTRACT' })
  }, 4000)
}
```

### Extraction retries trong zalo-main.js

```js
var EXTRACTION_RETRIES = 6       // Tối đa 6 lần
var EXTRACTION_RETRY_DELAY = 1500 // Cách nhau 1.5s

for (let round = 1; round <= EXTRACTION_RETRIES; round++) {
  const snapshot = await collectSnapshot(zs)
  // Giữ kết quả tốt nhất (nhiều friends/groups nhất)
  if (round >= 3 && (best.groups.length > 0 || best.friends.length > 0)) break
  await delay(EXTRACTION_RETRY_DELAY)
}
```

---

## 11. Tại sao cần 2 content scripts?

| Đặc điểm | `zalo-main.js` (MAIN) | `zalo-bridge.js` (ISOLATED) |
|---|---|---|
| **Truy cập JS Zalo** | ✅ `window.$$afmc`, `webpackJsonp` | ❌ Không thể |
| **Chrome APIs** | ❌ Không có | ✅ `chrome.runtime`, `chrome.tabs` |
| **Monkey-patch** | ✅ WebSocket, fetch | ❌ Không ảnh hưởng trang |
| **An toàn** | ❌ Có thể bị trang can thiệp | ✅ Cô lập hoàn toàn |
| **Mục đích** | Khai thác dữ liệu nội bộ Zalo | Relay dữ liệu lên background an toàn |

Đây là pattern chuẩn của Chrome Extension khi cần **vừa truy cập JS nội bộ trang, vừa dùng Chrome APIs**.

---

*Tài liệu này mô tả extension AutoZalo Bridge v5.0.0*
