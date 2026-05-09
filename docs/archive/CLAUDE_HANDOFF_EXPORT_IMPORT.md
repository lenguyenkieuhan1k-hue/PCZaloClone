# Handoff: Phân tích & Hoàn thiện cơ chế Export/Import Profile ZaloMask

> Gửi Claude: Đọc toàn bộ file này, đọc thêm các file code liên quan được liệt kê, rồi triển khai các nhiệm vụ theo thứ tự ưu tiên.

---

## 1. Bối cảnh sản phẩm

**ZaloMask** là Electron app cho phép chạy nhiều tài khoản Zalo song song trên Windows.

- Runtime: **Zalo PC desktop** — chạy `Zalo.exe` gốc với cây `AppData` riêng biệt từng profile
- Profile lưu tại: `profiles/<profileName>/` — gồm `meta.json` + cây `AppData/Roaming/ZaloData/`
- Export format: `.zmb` = ZIP archive chứa cây AppData + `manifest.json`
- Entry point: `app/main.v2.js`

---

## 2. Đối thủ phân tích: ZaX

Trong buổi nghiên cứu, đã reverse-engineer app ZaX (Electron + Zalo Web `chat.zalo.me`).

### ZaX dùng kiến trúc khác hoàn toàn:

- **Runtime**: Zalo **Web** trong Electron session partition, KHÔNG phải Zalo PC desktop
- **Session state**: cookie + localStorage trong `session.fromPartition('persist:...')`
- **Export**: file JSON nhỏ (~30-80KB), có thể transfer dễ dàng

### ZaX export JSON format:
```json
{
  "format": "zax-account",
  "cookies": [
    { "name": "zpsid", "value": "...", "domain": ".zalo.me", "expirationDate": 1760000000 }
  ],
  "localStorage": {
    "sh_z_uuid": "abc123",
    "z_uuid": "abc123"
  },
  "imei": "device-fingerprint-string"
}
```

### ZaX 2-phase restore (quan trọng):
```
Phase 1 — restore-session mode (trước khi load UI):
  app.requestSingleInstanceLock()
  → đọc meta.bin (cookie + imei)
  → session.fromPartition(partition).cookies.set(cookie) × N   [bơm từng cookie]
  → inject sh_z_uuid vào localStorage
  → xóa cờ needSyncCookies
  → app.relaunch() + app.quit()

Phase 2 — normal mode:
  → Zalo Web load lên với session đã ready
  → Không QR, không login
```

**Key insight**: ZaX bơm session TRƯỚC khi app load, không phải sau. Đây là lý do họ không bị "flash login screen".

### Lý do ZaX làm được còn ZaloMask thì khó hơn:

| | ZaX (Zalo Web) | ZaloMask (Zalo PC) |
|---|---|---|
| Cookie storage | Electron `cookies.get/set()` API | Chromium SQLite file `Network/Cookies` |
| AES key bảo vệ cookie | Không có (Electron quản lý) | **DPAPI** — gắn chặt user/machine Windows |
| Export | JSON thuần, portable 100% | Cần giải quyết DPAPI khi chuyển máy |
| Import | `cookies.set()` là xong | Phải re-DPAPI-protect AES key cho máy mới |

---

## 3. Root cause "bắt login lại sau import" của ZaloMask

### Cấu trúc mã hoá cookie của Chromium (Zalo PC dùng Chromium-based):

```
AppData/Roaming/ZaloData/
├── Local State          ← chứa: os_crypt.encrypted_key = "DPAPI" + <DPAPI blob>
│                            DPAPI blob = AES-256 key (32 bytes) được Windows bảo vệ
│                            → chỉ giải mã được trên cùng Windows user/machine
├── Network/Cookies      ← SQLite DB, mỗi cookie value = AES-GCM encrypted blob v10
│                            dùng AES key từ Local State
└── ...
```

### Vòng đời mã hoá:
```
1. Chromium tự sinh AES-256 key (32 bytes) lần đầu chạy
2. Bọc key đó bằng DPAPI: ProtectedData.Protect(rawKey, null, CurrentUser)
3. Ghi vào Local State: "DPAPI" + base64(DPAPIBlob)
4. Khi cần đọc cookie: Unprotect(DPAPIBlob) → rawKey → AES-GCM decrypt cookie value
```

### Vấn đề khi copy sang máy B:
```
Máy A: DPAPI(userA, machineA, rawKey) = DPAPIBlob_A → lưu trong Local State
Máy B: copy nguyên Local State → DPAPIBlob_A vẫn gắn machineA
       DPAPI.Unprotect(DPAPIBlob_A) trên máy B → FAIL (key scope khác)
       → AES key = null → decrypt cookie = garbage → Zalo bắt login lại
```

---

## 4. Giải pháp đã implement trong session này

**File sửa: `app/main.v2.js`**

### 4.1. Helper: `extractChromiumCookieKey(localStatePath)`
```javascript
// Đọc Local State → strip prefix "DPAPI" (5 bytes) → DPAPI.Unprotect
// → trả raw AES-256 key dạng base64
// Chạy bằng PowerShell: ProtectedData.Unprotect(blob, null, CurrentUser)
```

### 4.2. Helper: `applyChromiumCookieKey(localStatePath, cookieKeyB64)`
```javascript
// Nhận raw key base64 → DPAPI.Protect(rawKey, null, CurrentUser) trên máy đích
// → patch Local State.os_crypt.encrypted_key với key mới re-protected
// Kết quả: Chromium trên máy B đọc được cookie từ máy A
```

### 4.3. Patch `buildDesktopPackageManifestEntry`
```javascript
// Thêm field cookieKeyB64 vào manifest entry của mỗi profile
// = extractChromiumCookieKey(stagedDir/AppData/Roaming/ZaloData/Local State)
```

### 4.4. Patch `importDesktopProfilesArchive`
```javascript
// Sau copyDirectoryFiltered(sourceDir, destDir):
// if (profile.cookieKeyB64) → applyChromiumCookieKey(destDir/Local State, cookieKeyB64)
// log: "import-cookie-key-apply": { applied: true/false }
```

---

## 5. Trạng thái hiện tại sau vòng implement này (tóm tắt)

- Graceful terminate trước export (tăng xác suất flush WAL/LevelDB)
- Classify file critical vs volatile hợp lý (WAL/log/lock là volatile)
- DPAPI smoke test lúc boot có log `dpapi-key-extract-test`
- Cloud import buffer reuse chung import path archive
- Restore health có `cookieKeyApplied*`

---

## 6. Files cần đọc trước khi implement

```
app/main.v2.js               ← entry point chính, toàn bộ logic export/import
app/clone/clone-runtime.js   ← launchPcProfile, terminatePcProfile, resolveProfileDesktopEnv
```

---

## 7. Định nghĩa "Done" cho task này

1. Runtime log lúc boot có `"dpapi-key-extract-test"` với `ok: true` và `keyLength: 32`
2. Export profile từ **máy A** → `.zmb`
3. Import `.zmb` trên **máy B** (Windows user khác, machine khác)
4. Runtime log lúc import có `"import-cookie-key-apply": { applied: true }`
5. Mở profile → vào thẳng Zalo, **không có màn hình QR**
6. Test lặp ít nhất 3 lần mà vẫn ổn định

