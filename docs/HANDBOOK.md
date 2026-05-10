# ZaloMask Handbook (dev)

> Mục tiêu file này: gom các “luồng quan trọng” của app + đường dẫn code liên quan,
> để dev mới vào repo biết đọc từ đâu và debug như thế nào.

## 1) Hai phần chính của repo

- **Desktop app**: `app/` (Electron)
  - Entry: `app/main.v2.js` (được trỏ bởi `app/package.json.main`)
  - UI: `app/renderer/index-v2.html`, `app/renderer/renderer-v2.js`
  - Bridge IPC: `app/preload.js`
- **Web backend**: `web/` (Next.js + Supabase)
  - API license/heartbeat/cloud sync/payment: `web/app/api/**`

## 2) Profiles (dữ liệu user)

- Mỗi profile lưu trong `profiles/<profileName>/meta.json`
- Luồng chính **Zalo PC**: launch qua `app/clone/clone-runtime.js` + bundled `app/zalo-runtime/`.
- Dữ liệu import cũ có thể còn field web2 — normalize vẫn chạy PC (xem `AGENTS.md`).

Nguồn sự thật về format `meta.json`, IPC, cloud sync: xem `../AGENTS.md`.

## 3) Luồng mở profile (desktop app)

Nơi đi qua chính:

- Renderer gọi `window.api.openProfile(name)` → IPC `open-profile`
- Main xử lý tại `app/main.v2.js`
  - Load meta + kiểm tra quota/license
  - `ensurePcRuntimePatchReady` → `cloneRuntime.launchPcProfile` trong `app/clone/clone-runtime.js`

## 4) Proxy (PC runtime)

### 4.1 Vì sao cần local proxy bridge?

Chromium/Zalo.exe không ổn định khi dùng `--proxy-server` kèm credentials (`user:pass@host:port`).
Vì vậy app tạo **local HTTP proxy** (bridge) trên `127.0.0.1:<port>` và tự inject header
`Proxy-Authorization` cho upstream proxy.

Files:

- `app/proxy-bridge.js`: bridge mặc định (ổn định)
- `app/proxy-bridge-verbose.js`: bridge có log chi tiết CONNECT/HTTP để debug
- `app/clone/clone-runtime.js`: `ensureProxyBridge()` + map proxy config → `--proxy-server=http://127.0.0.1:<port>`

Log debug:

- Bridge verbose log: `C:\ProgramData\ZaloMask\proxy\<profile>.bridge.log`

### 4.2 QUIC/HTTP3

Khi bật proxy, Zalo.exe bị “offline” nếu ưu tiên QUIC/HTTP3 (UDP). App nên launch Zalo.exe kèm:

- `--disable-quic`
- `--disable-features=UseDnsHttpsSvcb,UseHttp3`

## 5) Privacy (PC runtime: ẩn đang soạn/đã xem/đã nhận)

Privacy hoạt động bằng cách patch runtime (asar) và inject shim để chặn các request “typing/seen/received”.

Files:

- `app/clone/clone-runtime.js`: `ensureAsarPatched()` copy shim vào `C:\ProgramData\ZaloMask\shim\`
- `app/clone/clone-main-shim.js`: chạy trong main process của Zalo.exe, áp privacy rules
- `app/clone/privacy-shim.js`: phần chặn request/điều chỉnh hành vi

Markers/log:

- `C:\ProgramData\ZaloMask\privacy\*.clone-shim-loaded.json` (shim đã load)

## 6) Export/Import / Cloud Sync

Tài liệu chi tiết nằm trong `../AGENTS.md` (Cloud sync) và các note trong `../KE_HOACH.md`.

Nguyên tắc:

- Không commit `profiles/` và các file export (`*.zlp`, `*.zmb`, `*.json` backup).
- Cloud sync chỉ hoạt động khi license **active** và enforce single-session.

## 7) Run / build

Desktop app (dev):

```powershell
cd app
npm install
npm start
```

Web (dev):

```powershell
cd web
npm install
npm run dev
```

Build installer:

```powershell
cd app
npx electron-builder --win nsis --x64 --publish never
```

## 8) Chỗ hay debug nhanh

- Desktop runtime log: `../app-runtime.log`
- Proxy bridge log (verbose): `C:\ProgramData\ZaloMask\proxy\*.bridge.log`
- Privacy markers: `C:\ProgramData\ZaloMask\privacy\`

