# ZaloMask — AI Agent Reference (v2, 2026-05-07)

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
│   │       ├── extension-import/route.ts
│   │       └── dev/seed-license/route.ts
│   ├── lib/
│   │   ├── supabase.ts          ← browser/server/admin clients
│   │   ├── plans.ts             ← bảng giá nguồn (6 tier: tier-1 free + 5 paid)
│   │   ├── license-token.ts     ← Ed25519 sign/verify
│   │   └── auth-helpers.ts
│   ├── supabase/migrations/0001_init.sql
│   ├── scripts/smoke-license.ps1
│   └── package.json
├── extension/                    ← Chrome ext AutoZalo Bridge v5
│   ├── manifest.json
│   ├── background.js
│   ├── content/{zalo-main,zalo-bridge,web-bridge}.js
│   └── EXTENSION_SESSION_FLOW.md
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
| `exportProfile(name)` | `export-profile` | Xuất 1 JSON với checksum |
| `exportProfiles(names)` | `export-profiles` | Bundle nhiều profile |
| `importProfile()` | `import-profile` | Nhập file JSON, tạo profile mới |
| `openProfilesFolder()` | `open-profiles-folder` | Mở thư mục `profiles/` |
| `getSettings()` | `get-settings` | Đọc privacy + global flags |
| `setSetting(key, value)` | `set-setting` | Ghi settings |
| `getSystemHealth()` | `get-system-health` | Snapshot tình trạng app |
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
- Server trả `status: 'kicked'|'expired'` → broadcast `license-kicked` event,
  delay 600ms cho UI render dialog, rồi đóng tất cả webWindows.

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
| `/api/extension-import` | Chrome ext push session về |
| `/api/dev/seed-license` | Dev test (NODE_ENV != production) |

Schema Postgres: `web/supabase/migrations/0001_init.sql` — bảng `users`,
`licenses`, `sessions`, `payments`, `audit_log`. Cộng thêm cần migrations
mới cho `web_sessions` (extension import) — xem TODO trong KE_HOACH.

License token Ed25519 — sign ở `web/lib/license-token.ts`, verify ở
`app/main.v2.js::verifyLicenseToken`. Public key paste vào
`config.json::licensePublicKeyPem`.

## 10. Chrome extension (`extension/`)

AutoZalo Bridge v5 (MV3). Inject content scripts MAIN+ISOLATED world vào
`chat.zalo.me`. Khi user đăng nhập trong cửa sổ incognito được mở từ trang
quản lý, extension capture cookies + zStorage + localStorage rồi POST về
`POST /api/extension-import` với header
`Authorization: Apikey <EXTENSION_IMPORT_SECRET>` (hoặc `Bearer <sb-access-token>`
nếu user đang đăng nhập trên web).

Backend tạo row `web_sessions(user_id, z_uuid, cookies, local_storage, ...)`.
Electron app pull về để mở thẳng profile mà không cần quét QR.

> **Hiện tại** bảng `web_sessions` chưa có trong `0001_init.sql`. Khi chạy
> endpoint sẽ fail với "table not found". Migration mới cần thêm trước khi
> deploy extension flow lên prod.

## 11. Gotchas

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

## 12. Không nên làm

- Đừng thêm code mới vào `app/legacy/` — chỉ giữ tham khảo, sẽ xoá hẳn sau.
- Đừng đọc `process.env.APPDATA` để lưu data — dùng `app.getPath('userData')`
  (nhưng tốt nhất giữ data trong `profiles/` của repo để portable).
- Đừng commit `profiles/`, `license-state.json`, `app-runtime.log`,
  `.env.local`, `*.json` export, `*.pfx`. Đã có `.gitignore`.
- Đừng đụng `electron-builder` config trong `app/package.json` mà không test
  build local trước (`npx electron-builder --win nsis --x64 --publish never`).
