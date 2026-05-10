# ZaloMask — AI Agent Reference (v2, 2026-05-07)

## 0. Current Runtime Note (2026-05-08)

- Nhánh code hiện tại đã chuyển sang PC-only cho profile launch:
  `add-profile` và `open-profile` mặc định/ép dùng `launchMode: 'pc'`.
- Zalo Web (`web2`) vẫn còn một số hàm legacy để tương thích dữ liệu cũ,
  nhưng luồng tạo/mở profile chính là Zalo PC bundled runtime.
- Preflight patch bundle (`ensurePcRuntimePatchReady` → `ensureAsarPatched`) chạy
  trước **mọi** lần launch Zalo PC: `open-profile`, `add-profile`, `launch-all`,
  import (archive + JSON legacy), shortcut `--zalomask-open-profile`, và boot timer.
  `asar-patch-boot` ghi log và cập nhật `asarPatchState` giống các luồng khác.
- **Pre-patch trước khi `npm run dist`:** `predist` chạy `scripts/patch-zalo-runtime-for-pack.js`
  trên `app/zalo-runtime` (sau `setup-zalo-runtime.ps1`). Installer bung ra Program Files đã có
  `app.asar` + stamp đọc được → `pickRuntimeDirAsync` **không** buộc copy sang Local nếu bundle chỉ đọc.
- Runtime copy đích nằm trong **`%LocalAppData%\ZaloMask\runtime\zalo-runtime`** (không dùng Roaming)
  để tránh đồng bộ cloud. Trước copy **xoá hết** thư mục đích nếu tree lệch / copy dở
  (tránh `EEXIST` trên `app.asar`); copy dùng `fs.promises.cp`, nếu lỗi thì fallback **robocopy**
  trên Windows; giảm khóa UI. **Không** fallback về bundle Program Files khi copy thất bại — trả lỗi
  hướng dẫn xóa `...\Local\ZaloMask\runtime\zalo-runtime` thay vì báo `asar-not-writable` nhầm chỗ.
- `getRuntimeStatus()` là **async** (IPC handlers phải `await`).
- Proxy auth cho Zalo PC hiện đi qua local HTTP bridge theo từng profile:
  app tạo proxy `127.0.0.1:<port>` cục bộ, tự inject `Proxy-Authorization`
  lên upstream HTTP proxy rồi truyền local endpoint đó vào `--proxy-server`.
  SOCKS5 auth vẫn chưa được hỗ trợ.

Đọc file này TRƯỚC khi sửa code. Nếu thấy bất cứ chỗ nào file này lệch với
code thực tế, cập nhật lại đây ngay khi PR.

## 1. Mục tiêu sản phẩm

ZaloMask cho phép một user trên Windows chạy **nhiều tài khoản Zalo Web song
song** trong cùng một ứng dụng Electron, mỗi tài khoản được cô lập 100% qua
`partition` Chromium riêng + browser fingerprint giả lập riêng.

## 2. Kiến trúc hiện tại (v2 — web2)

```
                ┌────────────────────────────────────┐
                │   ZaloMask Electron (main process) │
                │   app/main.v2.js                   │
                │                                    │
                │   • createMainWindow() → UI quản lý │
                │   • openWebProfile() → 1 BrowserWin │
                │     mỗi profile, partition riêng    │
                │   • license heartbeat 30s           │
                │   • cloud sync (upload/download)    │
                │   • auto-update GitHub Releases     │
                └─────────┬─────────────────────┬────┘
                          │ipc                  │
                ┌─────────▼────────┐   ┌────────▼─────────┐
                │ Renderer chính   │   │ N x BrowserWin   │
                │ (UI quản lý)     │   │ chat.zalo.me     │
                │                  │   │                  │
                │ index-v2.html    │   │ web-preload-v2.js│
                │ renderer-v2.js   │   │   • spoof FP     │
                │ style-v2.css     │   │   • seed LS      │
                │                  │   │   • capture LS   │
                │ preload: app/    │   └──────────────────┘
                │ preload.js       │
                └──────────────────┘
```

Mỗi profile lưu vào `profiles/<profileName>/meta.json` (cookies +
localStorage + fingerprint + proxy).

## 3. Cấu trúc thư mục

```
PCZaloClone/
├── app/
│   ├── main.v2.js                ← entry point (đọc package.json.main)
│   ├── preload.js                ← context bridge cho UI quản lý
│   ├── web-preload-v2.js         ← preload cho mỗi Zalo Web BrowserWindow
│   ├── auto-update.js            ← poll GitHub Releases, IPC update-*
│   ├── proxy-test.ps1            ← script test proxy thủ công (dev)
│   ├── package.json              ← main: "main.v2.js"
│   ├── renderer/
│   │   ├── index-v2.html         ← UI chính
│   │   ├── renderer-v2.js
│   │   ├── style-v2.css
│   │   └── assets/{app-icon.ico,app-icon.png,logo-zalomask.svg}
│   └── legacy/                   ← code v1 (clone Zalo PC). Không build.
├── web/
│   ├── app/
│   │   ├── page.tsx              ← landing
│   │   ├── pricing/page.tsx
│   │   ├── checkout/[plan]/page.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── admin/page.tsx
│   │   ├── auth/sign-in/page.tsx
│   │   ├── auth/callback/route.ts
│   │   ├── terms/page.tsx
│   │   ├── privacy/page.tsx
│   │   └── api/
│   │       ├── activate/route.ts
│   │       ├── heartbeat/route.ts
│   │       ├── claim-free/route.ts
│   │       ├── sepay-webhook/route.ts
│   │       ├── cloud-sync/upload/route.ts   ← cloud sync upload
│   │       ├── cloud-sync/download/route.ts ← cloud sync download
│   │       └── dev/seed-license/route.ts
│   ├── lib/
│   │   ├── supabase.ts          ← browser/server/admin clients
│   │   ├── plans.ts             ← bảng giá nguồn (6 tier: tier-1 free + 5 paid)
│   │   ├── license-token.ts     ← Ed25519 sign/verify
│   │   └── auth-helpers.ts
│   ├── supabase/migrations/0001_init.sql
│   ├── supabase/migrations/0002_web_sessions.sql
│   ├── supabase/migrations/0003_cloud_sync.sql ← bảng cloud_backups
│   ├── scripts/smoke-license.ps1
│   └── package.json
├── profiles/                     ← user profiles (gitignored)
├── config.json                   ← app settings + license API base + GitHub repo
├── README.md
├── AGENTS.md                     ← file này
└── KE_HOACH.md
```

## 4. IPC API (preload.js ↔ main.v2.js)

| `window.api.method` | IPC channel | Mô tả |
|---|---|---|
| `listProfiles()` | `list-profiles` | Danh sách profile cùng meta cô đọng |
| `getProfileInfo(name)` | `get-profile-info` | Toàn bộ meta JSON của profile |
| `addProfile(displayName, proxy)` | `add-profile` | Tạo profile mới (kiểm tra quota) |
| `openProfile(name)` | `open-profile` | Mở Zalo Web BrowserWindow |
| `launchAll()` | `launch-all` | Mở mọi profile song song |
| `deleteProfile(name)` | `delete-profile` | Xoá profile + partition data |
| `updateProxy(name, proxy)` | `update-proxy` | Cập nhật proxy meta |
| `checkProxy(proxy)` | `check-proxy` | Test proxy bằng curl |
| `exportProfile(name, opts?)` | `export-profile` | Xuất package desktop (`.zmb`/…); `opts.deleteAfterExport` xóa profile sau khi lưu file |
| `exportProfiles(names, opts?)` | `export-profiles` | Sao lưu nhiều profile; `opts.deleteAfterExport` tương tự |
| `importProfile()` | `import-profile` | Nhập package `.zlp/.zip`, fallback JSON legacy |
| `createProfileShortcut(name)` | `create-profile-shortcut` | Tạo shortcut Desktop mở trực tiếp profile |
| `openProfilesFolder()` | `open-profiles-folder` | Mở thư mục `profiles/` |
| `getSettings()` | `get-settings` | Đọc privacy + global flags |
| `setSetting(key, value)` | `set-setting` | Ghi settings |
| `getSystemHealth()` | `get-system-health` | Snapshot tình trạng app |
| `exportDiagnostics()` | `export-diagnostics` | Lưu ZIP chẩn đoán (manifest + runtime + log đã redact) |
| `logToMain(level, message, detail?)` | `client-log` | Renderer gửi lỗi JS / reject vào `app-runtime.log` |
| `getLicenseStatus()` | `get-license-status` | Đọc license-state.json |
| `activateLicense(key)` | `activate-license` | Gọi `/api/activate` |
| `deactivateLicense()` | `deactivate-license` | Xoá license-state.json |
| `heartbeatLicense()` | `license-heartbeat` | Gọi `/api/heartbeat` thủ công |
| `cloudSyncUpload()` | `cloud-sync-upload` | Upload toàn bộ profiles lên cloud |
| `cloudSyncDownload()` | `cloud-sync-download` | Tải profiles từ cloud về máy |
| `cloudSyncStatus()` | `cloud-sync-status` | Kiểm tra trạng thái backup cloud |
| `updateCheck()` | `update-check` | Poll GitHub Releases ngay |
| `updateDownload()` | `update-download` | Tải installer |
| `updateInstall()` | `update-install` | Chạy installer + quit |
| `updateStatus()` | `update-status` | Tình trạng download |
| `closeWindow()` | `close-window` (send) | Đóng cửa sổ chính |
| `minimizeWindow()` | `minimize-window` (send) | Thu nhỏ |

Events từ main → renderer:
- `profile-updated(profileName)` — sau capture session
- `profiles-reloaded` — sau cloud download hoàn tất
- `license-updated(state)` — sau activate / heartbeat
- `license-kicked({status, message, state})` — server báo kicked/expired
- `update-available({localVersion, remoteVersion, releaseNotes})`
- `update-download-progress({percent, received, total})`

## 5. Cấu trúc `profiles/<name>/meta.json`

```json
{
  "displayName": "Zalo Web 1",
  "profileName": "zalo_web_1",
  "launchMode": "web2",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "proxy": {
    "enabled": true,
    "protocol": "HTTP",
    "host": "1.2.3.4",
    "port": 8080,
    "authEnabled": true,
    "username": "...",
    "password": "..."
  },
  "fingerprint": {
    "id": "0e297e9b10044ecd",
    "version": 1,
    "userAgent": "Mozilla/5.0 ...",
    "platform": "Win32",
    "vendor": "Google Inc.",
    "language": "vi-VN",
    "languages": ["vi-VN", "en-US", "en"],
    "timezone": "Asia/Ho_Chi_Minh",
    "hardwareConcurrency": 8,
    "deviceMemory": 8,
    "maxTouchPoints": 0,
    "webglVendor": "...",
    "webglRenderer": "..."
  },
  "webSession": {
    "zUuid": "<uuid>",
    "cookies": [...],
    "cookieString": "name=value; ...",
    "localStorage": { "sh_z_uuid": "...", ... },
    "session": null,
    "seededAt": "ISO",
    "cookieCapturedAt": "ISO",
    "storageCapturedAt": "ISO"
  }
}
```

## 6. Web profile lifecycle

`openWebProfile(profileName)` (main.v2.js dòng ~770):

1. Đọc meta. Nếu không có fingerprint → `generateFingerprint()` random + lưu lại.
2. Lấy `session.fromPartition('persist:web2:<profileName>')`.
3. Nếu `proxy.enabled`: chạy `checkProxyViaCurl` → fail mở → throw lỗi.
4. `ses.setProxy(buildSessionProxyConfig(proxy))`.
5. Tạo `BrowserWindow` với `partition` + preload `web-preload-v2.js` +
   `additionalArguments: [--zalomask-profile=<name>, --zalomask-zuuid=<uuid>]`.
6. `setUserAgent(fingerprint.userAgent || ZALO_WEB_USER_AGENT)`.
7. `loadURL('https://chat.zalo.me/')` (fallback `id.zalo.me/account?...`).
8. Đăng ký `cookies.on('changed')` → `scheduleCookieSave` 1.5s debounce.
9. `web-preload-v2.js` capture localStorage qua IPC `v2:web-session-snapshot`
   sau load+5s và load+20s.

`web-preload-v2.js` áp fingerprint qua `Object.defineProperty(Navigator.prototype, ...)`,
patch `Intl.DateTimeFormat.prototype.resolvedOptions`, monkey-patch
`WebGLRenderingContext.getParameter` → tránh Zalo phát hiện máy clone.

## 7. License client

State lưu ở `<repo-root>/license-state.json`:

```json
{
  "key": "ZM-...",
  "sessionId": "uuid",
  "token": "ed25519-signed",
  "tokenExpiresAt": "ISO",
  "licenseExpiresAt": "ISO",
  "status": "active|kicked|expired",
  "lastHeartbeatAt": "ISO",
  "accountQuota": 6
}
```

`getEffectiveProfileQuota()` rule:
- `requireLicense=false` (default) + chưa có license → `{ quota: 1, source: 'free' }`
- License `active` + chưa expire → `{ quota: license.accountQuota, source: 'license' }`
- License `expired/kicked` → fallback theo `requireLicense` (true → 0, false → 1)

`add-profile` IPC kiểm tra quota; vượt → trả `{ ok: false, message }`.

Heartbeat (`runHeartbeatOnce`):
- Server trả `status: 'ok'` → cập nhật `lastHeartbeatAt`.
- Server trả `status: 'kicked'` → **auto cloud upload** (runCloudUpload) →
  **terminate các tiến trình Zalo PC theo `pid.txt`** → **wipe tất cả
  profiles local** (wipeAllLocalProfiles) → broadcast `license-kicked`
  event.
- Server trả `status: 'expired'` → chỉ broadcast `license-kicked`, không wipe.

## 8. Cloud Sync

### Nghiệp vụ (single-session enforcement)

```
Machine A (active)          Server               Machine B
     │                         │                     │
     │── "Tải lên đám mây" ───►│ /api/cloud-sync/    │
     │   upload all profiles   │ upload              │
     │                         │ cloud_backups upsert│
     │                         │                     │
     │◄── heartbeat kicked ────│◄── activate key ────│
     │                         │  active_session_id  │
     │  auto-upload (silent)   │  → Machine B        │
     │── upload final state ──►│                     │
     │  wipe local profiles    │                     │
     │  show kicked dialog     │                     │
     │                         │                     │
     │                         │◄─ "Đồng bộ về" ─────│
     │                         │  download profiles  │
     │                         │─ profiles JSON ────►│
     │                         │                     │ save to local disk
```

### Schema (migration 0003_cloud_sync.sql)

Bảng `cloud_backups`:
- `user_id` (unique) — 1 backup slot/user, upsert on conflict
- `license_id`, `session_id` — phải khớp `active_session_id` trên license
- `profiles_json` — jsonb array toàn bộ profile meta
- `uploaded_at` — timestamp upload gần nhất

### API security

Cả upload lẫn download đều require:
1. Valid Supabase access token cookie (`sb-access-token`)
2. `sessionId` phải khớp `licenses.active_session_id` của user đó
3. License status phải là `active`

→ Machine A không thể download sau khi bị kicked (session_id không còn là active).

### IPC / helpers trong main.v2.js

- `runCloudUpload({ silent })` — helper nội bộ, gom tất cả profiles rồi POST `/api/cloud-sync/upload`
- `wipeAllLocalProfiles()` — helper nội bộ, `fs.rmSync` toàn bộ thư mục con trong PROFILES_DIR
- `getJson(url)` — helper fetch GET với 12s timeout (bên cạnh `postJson`)
- IPC `cloud-sync-upload` → manual upload từ UI
- IPC `cloud-sync-download` → download về + lưu vào PROFILES_DIR + emit `profiles-reloaded`
- IPC `cloud-sync-status` → kiểm tra có backup chưa (dùng GET download endpoint)

### UI (tab "Đồng bộ đám mây")

- Nút **Tải lên**: gọi `cloudSyncUpload()`, hiển thị profileCount tải lên
- Nút **Đồng bộ về**: gọi `cloudSyncDownload()`, refresh profile list
- Nút **Làm mới**: gọi `cloudSyncStatus()`, hiển thị trạng thái backup gần nhất
- Khi bị kicked: message dialog đề cập profiles đã sao lưu + hướng dẫn dùng "Đồng bộ về" ở máy mới

## 9. Auto-update

`auto-update.js`:
- Poll `https://api.github.com/repos/<owner>/<repo>/releases/latest` mỗi 60 phút.
- So sánh semver `release.tag_name` vs `app.getVersion()`.
- Nếu newer + có asset `ZaloMask-Setup-*.exe` → broadcast `update-available`.
- IPC `update-download` tải về `tmp`, `update-install` chạy installer detached.

`config.json` cần có:

```json
{
  "github": { "owner": "OWNER", "repo": "REPO", "prerelease": false }
}
```

CI workflow `.github/workflows/release.yml`: tag `v*` → electron-builder NSIS
→ publish lên GitHub Release.

## 10. Web (zalomask.com)

| Route | Mục đích |
|---|---|
| `/` | Landing |
| `/pricing` | 6 tier (tier-1 free + 5 paid) |
| `/checkout/[plan]?d=1m\|3m\|6m\|1y` | QR SePay (free → /api/claim-free) |
| `/dashboard` | License + thiết bị active |
| `/admin` | Doanh thu + users + licenses (gate `ADMIN_EMAILS`) |
| `/auth/sign-in` | Google OAuth |
| `/auth/callback` | Token exchange + set cookie |
| `/api/activate` | Electron app activate key |
| `/api/heartbeat` | Single-session check |
| `/api/sepay-webhook` | SePay → tạo key + email |
| `/api/claim-free` | Cấp key tier-1 free (1/user) |
| `/api/cloud-sync/upload` | Upload toàn bộ profiles (POST) |
| `/api/cloud-sync/download` | Download profiles về máy mới (GET) |
| `/api/dev/seed-license` | Dev test (NODE_ENV != production) |

Schema Postgres: `web/supabase/migrations/0001_init.sql` — bảng `users`,
`licenses`, `sessions`, `payments`, `audit_log`.
Cloud: `web/supabase/migrations/0003_cloud_sync.sql` — bảng `cloud_backups`.

License token Ed25519 — sign ở `web/lib/license-token.ts`, verify ở
`app/main.v2.js::verifyLicenseToken`. Public key paste vào
`config.json::licensePublicKeyPem`.

## 11. Extension module

Module Chrome extension đã được loại khỏi scope repository hiện tại.
Luồng chính sản phẩm chỉ gồm Electron app + web license/payment.

## 12. Gotchas

- **`chromium-win-bootstrap.js` + `spellcheck: false` (main window)** — tránh
  lỗi cache GPU/disk trên Windows và đơ UI khi gõ trong modal. Gọi ngay sau
  `require('electron')`. **`npm run predist`** chạy `assert-chromium-bootstrap.js`;
  không xóa hook đó khi đổi script build.
- **`main.v2.js` đọc `package.json.main`** — nếu file truncated, Electron
  sẽ load nhầm hoặc crash. Đã có sample bị truncated 2 lần do tool sync,
  cẩn thận khi sửa qua tool Write/Edit.
- **`session.fromPartition('persist:web2:<n>')`** — nếu profileName chứa ký
  tự đặc biệt (slash, colon), Chromium reject. `slugify()` đã xử nhưng kiểm
  tra lại nếu sửa.
- **`additionalArguments` không escape** — preload đọc raw `process.argv`,
  cẩn thận quote nếu profileName chứa space.
- **Cookies-Network/Cookies SQLite** không còn dùng — Chromium tự lưu trong
  partition data. Backup chỉ qua IPC export (cookies + localStorage thuần).
- **Heartbeat poll mỗi 30s** — nếu mất mạng, không có grace period offline
  (todo). Khi bị kicked, app auto-upload cloud rồi terminate tiến trình Zalo
  PC theo `pid.txt` trước khi wipe local profiles.
- **`license-state.json` ở root**, không trong `app/`. Đã thêm vào
  `.gitignore`.
- **`app-runtime.log` append-only** — chưa rotate. Ở dev có thể to nhanh.
- **Chẩn đoán máy khách:** Cài đặt → «Xuất chẩn đoán» (ZIP), hoặc CLI  
  `ZaloMask.exe --zalomask-diagnostics=C:\path\diag.zip` (thoát ngay sau khi ghi file).  
  Script: `scripts/collect-zalomask-diagnostics.ps1` (khi app không chạy).
- **Cloud sync backup dạng desktop package base64** trong `cloud_backups.profiles_json`
  (kind=`desktop-package`), có checksum SHA-256; vẫn fallback đọc dữ liệu
  legacy nếu backup cũ.
- **Cloud sync chỉ hoạt động khi có license active** — free tier không có
  cloud sync.

## 13. Không nên làm

- Đừng thêm code mới vào `app/legacy/` — chỉ giữ tham khảo, sẽ xoá hẳn sau.
- Đừng đọc `process.env.APPDATA` để lưu data — dùng `app.getPath('userData')`
  (nhưng tốt nhất giữ data trong `profiles/` của repo để portable).
- Đừng commit `profiles/`, `license-state.json`, `app-runtime.log`,
  `.env.local`, `*.json` export, `*.pfx`. Đã có `.gitignore`.
- Đừng đụng `electron-builder` config trong `app/package.json` mà không test
  build local trước (`npx electron-builder --win nsis --x64 --publish never`).


Đọc file này TRƯỚC khi sửa code. Nếu thấy bất cứ chỗ nào file này lệch với
code thực tế, cập nhật lại đây ngay khi PR.

## 1. Mục tiêu sản phẩm

ZaloMask cho phép một user trên Windows chạy **nhiều tài khoản Zalo Web song
song** trong cùng một ứng dụng Electron, mỗi tài khoản được cô lập 100% qua
`partition` Chromium riêng + browser fingerprint giả lập riêng.

## 2. Kiến trúc hiện tại (v2 — web2)

```
                ┌────────────────────────────────────┐
                │   ZaloMask Electron (main process) │
                │   app/main.v2.js                   │
                │                                    │
                │   • createMainWindow() → UI quản lý │
                │   • openWebProfile() → 1 BrowserWin │
                │     mỗi profile, partition riêng    │
                │   • license heartbeat 30s           │
                │   • auto-update GitHub Releases     │
                └─────────┬─────────────────────┬────┘
                          │ipc                  │
                ┌─────────▼────────┐   ┌────────▼─────────┐
                │ Renderer chính   │   │ N x BrowserWin   │
                │ (UI quản lý)     │   │ chat.zalo.me     │
                │                  │   │                  │
                │ index-v2.html    │   │ web-preload-v2.js│
                │ renderer-v2.js   │   │   • spoof FP     │
                │ style-v2.css     │   │   • seed LS      │
                │                  │   │   • capture LS   │
                │ preload: app/    │   └──────────────────┘
                │ preload.js       │
                └──────────────────┘
```

Mỗi profile lưu vào `profiles/<profileName>/meta.json` (cookies +
localStorage + fingerprint + proxy).

## 3. Cấu trúc thư mục

```
PCZaloClone/
├── app/
│   ├── main.v2.js                ← entry point (đọc package.json.main)
│   ├── preload.js                ← context bridge cho UI quản lý
│   ├── web-preload-v2.js         ← preload cho mỗi Zalo Web BrowserWindow
│   ├── auto-update.js            ← poll GitHub Releases, IPC update-*
│   ├── proxy-test.ps1            ← script test proxy thủ công (dev)
│   ├── package.json              ← main: "main.v2.js"
│   ├── renderer/
│   │   ├── index-v2.html         ← UI chính
│   │   ├── renderer-v2.js
│   │   ├── style-v2.css
│   │   └── assets/{app-icon.ico,app-icon.png,logo-zalomask.svg}
│   └── legacy/                   ← code v1 (clone Zalo PC). Không build.
├── web/
│   ├── app/
│   │   ├── page.tsx              ← landing
│   │   ├── pricing/page.tsx
│   │   ├── checkout/[plan]/page.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── admin/page.tsx
│   │   ├── auth/sign-in/page.tsx
│   │   ├── auth/callback/route.ts
│   │   ├── terms/page.tsx
│   │   ├── privacy/page.tsx
│   │   └── api/
│   │       ├── activate/route.ts
│   │       ├── heartbeat/route.ts
│   │       ├── claim-free/route.ts
│   │       ├── sepay-webhook/route.ts
│   │       └── dev/seed-license/route.ts
│   ├── lib/
│   │   ├── supabase.ts          ← browser/server/admin clients
│   │   ├── plans.ts             ← bảng giá nguồn (6 tier: tier-1 free + 5 paid)
│   │   ├── license-token.ts     ← Ed25519 sign/verify
│   │   └── auth-helpers.ts
│   ├── supabase/migrations/0001_init.sql
│   ├── scripts/smoke-license.ps1
│   └── package.json
├── profiles/                     ← user profiles (gitignored)
├── config.json                   ← app settings + license API base + GitHub repo
├── README.md
├── AGENTS.md                     ← file này
└── KE_HOACH.md
```

## 4. IPC API (preload.js ↔ main.v2.js)

| `window.api.method` | IPC channel | Mô tả |
|---|---|---|
| `listProfiles()` | `list-profiles` | Danh sách profile cùng meta cô đọng |
| `getProfileInfo(name)` | `get-profile-info` | Toàn bộ meta JSON của profile |
| `addProfile(displayName, proxy)` | `add-profile` | Tạo profile mới (kiểm tra quota) |
| `openProfile(name)` | `open-profile` | Mở Zalo Web BrowserWindow |
| `launchAll()` | `launch-all` | Mở mọi profile song song |
| `deleteProfile(name)` | `delete-profile` | Xoá profile + partition data |
| `updateProxy(name, proxy)` | `update-proxy` | Cập nhật proxy meta |
| `checkProxy(proxy)` | `check-proxy` | Test proxy bằng curl |
| `exportProfile(name, opts?)` | `export-profile` | Xuất package desktop (`.zmb`/…); `opts.deleteAfterExport` xóa profile sau khi lưu file |
| `exportProfiles(names, opts?)` | `export-profiles` | Sao lưu nhiều profile; `opts.deleteAfterExport` tương tự |
| `importProfile()` | `import-profile` | Nhập package `.zlp/.zip`, fallback JSON legacy |
| `createProfileShortcut(name)` | `create-profile-shortcut` | Tạo shortcut Desktop mở trực tiếp profile |
| `openProfilesFolder()` | `open-profiles-folder` | Mở thư mục `profiles/` |
| `getSettings()` | `get-settings` | Đọc privacy + global flags |
| `setSetting(key, value)` | `set-setting` | Ghi settings |
| `getSystemHealth()` | `get-system-health` | Snapshot tình trạng app |
| `exportDiagnostics()` | `export-diagnostics` | Lưu ZIP chẩn đoán (manifest + runtime + log đã redact) |
| `logToMain(level, message, detail?)` | `client-log` | Renderer gửi lỗi JS / reject vào `app-runtime.log` |
| `getLicenseStatus()` | `get-license-status` | Đọc license-state.json |
| `activateLicense(key)` | `activate-license` | Gọi `/api/activate` |
| `deactivateLicense()` | `deactivate-license` | Xoá license-state.json |
| `heartbeatLicense()` | `license-heartbeat` | Gọi `/api/heartbeat` thủ công |
| `updateCheck()` | `update-check` | Poll GitHub Releases ngay |
| `updateDownload()` | `update-download` | Tải installer |
| `updateInstall()` | `update-install` | Chạy installer + quit |
| `updateStatus()` | `update-status` | Tình trạng download |
| `closeWindow()` | `close-window` (send) | Đóng cửa sổ chính |
| `minimizeWindow()` | `minimize-window` (send) | Thu nhỏ |

Events từ main → renderer:
- `profile-updated(profileName)` — sau capture session
- `license-updated(state)` — sau activate / heartbeat
- `license-kicked({status, message, state})` — server báo kicked/expired
- `update-available({localVersion, remoteVersion, releaseNotes})`
- `update-download-progress({percent, received, total})`

## 5. Cấu trúc `profiles/<name>/meta.json`

```json
{
  "displayName": "Zalo Web 1",
  "profileName": "zalo_web_1",
  "launchMode": "web2",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "proxy": {
    "enabled": true,
    "protocol": "HTTP",
    "host": "1.2.3.4",
    "port": 8080,
    "authEnabled": true,
    "username": "...",
    "password": "..."
  },
  "fingerprint": {
    "id": "0e297e9b10044ecd",
    "version": 1,
    "userAgent": "Mozilla/5.0 ...",
    "platform": "Win32",
    "vendor": "Google Inc.",
    "language": "vi-VN",
    "languages": ["vi-VN", "en-US", "en"],
    "timezone": "Asia/Ho_Chi_Minh",
    "hardwareConcurrency": 8,
    "deviceMemory": 8,
    "maxTouchPoints": 0,
    "webglVendor": "...",
    "webglRenderer": "..."
  },
  "webSession": {
    "zUuid": "<uuid>",
    "cookies": [...],
    "cookieString": "name=value; ...",
    "localStorage": { "sh_z_uuid": "...", ... },
    "session": null,
    "seededAt": "ISO",
    "cookieCapturedAt": "ISO",
    "storageCapturedAt": "ISO"
  }
}
```

## 6. Web profile lifecycle

`openWebProfile(profileName)` (main.v2.js dòng ~770):

1. Đọc meta. Nếu không có fingerprint → `generateFingerprint()` random + lưu lại.
2. Lấy `session.fromPartition('persist:web2:<profileName>')`.
3. Nếu `proxy.enabled`: chạy `checkProxyViaCurl` → fail mở → throw lỗi.
4. `ses.setProxy(buildSessionProxyConfig(proxy))`.
5. Tạo `BrowserWindow` với `partition` + preload `web-preload-v2.js` +
   `additionalArguments: [--zalomask-profile=<name>, --zalomask-zuuid=<uuid>]`.
6. `setUserAgent(fingerprint.userAgent || ZALO_WEB_USER_AGENT)`.
7. `loadURL('https://chat.zalo.me/')` (fallback `id.zalo.me/account?...`).
8. Đăng ký `cookies.on('changed')` → `scheduleCookieSave` 1.5s debounce.
9. `web-preload-v2.js` capture localStorage qua IPC `v2:web-session-snapshot`
   sau load+5s và load+20s.

`web-preload-v2.js` áp fingerprint qua `Object.defineProperty(Navigator.prototype, ...)`,
patch `Intl.DateTimeFormat.prototype.resolvedOptions`, monkey-patch
`WebGLRenderingContext.getParameter` → tránh Zalo phát hiện máy clone.

## 7. License client

State lưu ở `<repo-root>/license-state.json`:

```json
{
  "key": "ZM-...",
  "sessionId": "uuid",
  "token": "ed25519-signed",
  "tokenExpiresAt": "ISO",
  "licenseExpiresAt": "ISO",
  "status": "active|kicked|expired",
  "lastHeartbeatAt": "ISO",
  "accountQuota": 6
}
```

`getEffectiveProfileQuota()` rule:
- `requireLicense=false` (default) + chưa có license → `{ quota: 1, source: 'free' }`
- License `active` + chưa expire → `{ quota: license.accountQuota, source: 'license' }`
- License `expired/kicked` → fallback theo `requireLicense` (true → 0, false → 1)

`add-profile` IPC kiểm tra quota; vượt → trả `{ ok: false, message }`.

Heartbeat (`runHeartbeatOnce`):
- Server trả `status: 'ok'` → cập nhật `lastHeartbeatAt`.
- Server trả `status: 'kicked'` → auto-upload cloud, terminate tiến trình
  Zalo PC theo `pid.txt`, wipe local profiles, rồi broadcast `license-kicked`.
- Server trả `status: 'expired'` → chỉ broadcast `license-kicked`, không wipe.

## 8. Auto-update

`auto-update.js`:
- Poll `https://api.github.com/repos/<owner>/<repo>/releases/latest` mỗi 60 phút.
- So sánh semver `release.tag_name` vs `app.getVersion()`.
- Nếu newer + có asset `ZaloMask-Setup-*.exe` → broadcast `update-available`.
- IPC `update-download` tải về `tmp`, `update-install` chạy installer detached.

`config.json` cần có:

```json
{
  "github": { "owner": "OWNER", "repo": "REPO", "prerelease": false }
}
```

CI workflow `.github/workflows/release.yml`: tag `v*` → electron-builder NSIS
→ publish lên GitHub Release.

## 9. Web (zalomask.com)

| Route | Mục đích |
|---|---|
| `/` | Landing |
| `/pricing` | 6 tier (tier-1 free + 5 paid) |
| `/checkout/[plan]?d=1m\|3m\|6m\|1y` | QR SePay (free → /api/claim-free) |
| `/dashboard` | License + thiết bị active |
| `/admin` | Doanh thu + users + licenses (gate `ADMIN_EMAILS`) |
| `/auth/sign-in` | Google OAuth |
| `/auth/callback` | Token exchange + set cookie |
| `/api/activate` | Electron app activate key |
| `/api/heartbeat` | Single-session check |
| `/api/sepay-webhook` | SePay → tạo key + email |
| `/api/claim-free` | Cấp key tier-1 free (1/user) |
| `/api/dev/seed-license` | Dev test (NODE_ENV != production) |

Schema Postgres: `web/supabase/migrations/0001_init.sql` — bảng `users`,
`licenses`, `sessions`, `payments`, `audit_log`.

License token Ed25519 — sign ở `web/lib/license-token.ts`, verify ở
`app/main.v2.js::verifyLicenseToken`. Public key paste vào
`config.json::licensePublicKeyPem`.

## 10. Extension module

Module Chrome extension đã được loại khỏi scope repository hiện tại.
Luồng chính sản phẩm chỉ gồm Electron app + web license/payment.

## 11. Gotchas

- **`chromium-win-bootstrap.js` + `spellcheck: false` (main window)** — tránh
  lỗi cache GPU/disk trên Windows và đơ UI khi gõ trong modal. Gọi ngay sau
  `require('electron')`. **`npm run predist`** chạy `assert-chromium-bootstrap.js`;
  không xóa hook đó khi đổi script build.
- **`main.v2.js` đọc `package.json.main`** — nếu file truncated, Electron
  sẽ load nhầm hoặc crash. Đã có sample bị truncated 2 lần do tool sync,
  cẩn thận khi sửa qua tool Write/Edit.
- **`session.fromPartition('persist:web2:<n>')`** — nếu profileName chứa ký
  tự đặc biệt (slash, colon), Chromium reject. `slugify()` đã xử nhưng kiểm
  tra lại nếu sửa.
- **`additionalArguments` không escape** — preload đọc raw `process.argv`,
  cẩn thận quote nếu profileName chứa space.
- **Cookies-Network/Cookies SQLite** không còn dùng — Chromium tự lưu trong
  partition data. Backup chỉ qua IPC export (cookies + localStorage thuần).
- **Heartbeat poll mỗi 30s** — nếu mất mạng, không có grace period offline
  (todo). Kicked dialog có 600ms delay trước khi đóng webWindows.
- **`license-state.json` ở root**, không trong `app/`. Đã thêm vào
  `.gitignore`.
- **`app-runtime.log` append-only** — chưa rotate. Ở dev có thể to nhanh.
- **Chẩn đoán máy khách:** Cài đặt → «Xuất chẩn đoán» (ZIP), hoặc CLI  
  `ZaloMask.exe --zalomask-diagnostics=C:\path\diag.zip` (thoát ngay sau khi ghi file).  
  Script: `scripts/collect-zalomask-diagnostics.ps1` (khi app không chạy).

## 12. Không nên làm

- Đừng thêm code mới vào `app/legacy/` — chỉ giữ tham khảo, sẽ xoá hẳn sau.
- Đừng đọc `process.env.APPDATA` để lưu data — dùng `app.getPath('userData')`
  (nhưng tốt nhất giữ data trong `profiles/` của repo để portable).
- Đừng commit `profiles/`, `license-state.json`, `app-runtime.log`,
  `.env.local`, `*.json` export, `*.pfx`. Đã có `.gitignore`.
- Đừng đụng `electron-builder` config trong `app/package.json` mà không test
  build local trước (`npx electron-builder --win nsis --x64 --publish never`).
