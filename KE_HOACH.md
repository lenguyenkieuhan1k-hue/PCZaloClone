# Kế hoạch phát triển ZaX / ZaloMask

> File này lưu toàn bộ ý tưởng + lộ trình phát triển sản phẩm.
> Mở lại file này khi muốn nhớ "đã quyết những gì, đang ở đâu, làm gì tiếp".

## 0. Cập nhật nhanh (2026-05-07)

- Runtime đang dùng thực tế: `app/main.v2.js` (web profile v2), không còn chạy mặc định theo luồng clone desktop cũ.
- Đã ổn định luồng import/export và giữ phiên đăng nhập web (cookies + localStorage).
- Đã sửa lỗi crash khi mở profile do seed localStorage quá lớn (chuyển sang sync IPC seed).
- UI v2 đã bổ sung:
   - Nhập proxy khi tạo profile.
   - Sửa proxy riêng từng profile trong danh sách (modal Proxy).
   - Kiểm tra proxy trực tiếp từ app (Live/Fail + IP nếu lấy được).
   - Check proxy nhanh ngay trên từng dòng profile.
   - Cài đặt dùng switch toggle.
   - Tool card có icon để thao tác nhanh (Mở thư mục, Mở tất cả, Nhập, Xuất).
- Sao lưu đã hỗ trợ chọn 1 hoặc nhiều profile cùng lúc (bundle JSON), import bundle nhiều profile.
- Mỗi profile mới đã có browser fingerprint riêng, hợp lý và ổn định theo profile.
- Sao lưu/khôi phục đã mang theo fingerprint browser + proxy để đồng nhất môi trường.
- Khi mở profile có proxy bật: bắt buộc kiểm tra proxy trước; proxy lỗi thì chặn mở profile.
- Tài liệu và README đã cập nhật theo runtime mới.

Ghi chú:
- Các phần bên dưới vẫn giữ để tham chiếu lịch sử kế hoạch cũ, không còn phản ánh chính xác runtime mặc định hiện tại.

## 0c. Cập nhật nhanh (2026-05-08)

### Đã hoàn thành trong app desktop (`app/main.v2.js`, `renderer-v2.js`)

- Hoàn thiện runtime license khi khởi động app:
   - thêm `bootLicenseRuntime()` để broadcast trạng thái ngay khi mở app,
   - chỉ bật heartbeat timer khi session còn `active`,
   - chạy heartbeat một lần khi boot để đồng bộ trạng thái server.
- Hoàn thiện UI License ở renderer:
   - đã bind đủ 4 nút `Kích hoạt / Heartbeat / Làm mới trạng thái / Gỡ kích hoạt`,
   - có formatter summary trạng thái/quota/session/expiry/heartbeat,
   - có lắng nghe event `license-updated` từ main process.
- Chốt rule free tier trong app desktop:
   - khi **chưa kích hoạt key** vẫn dùng app bình thường,
   - mặc định giới hạn **1 profile** (free quota),
   - vượt quá 1 profile sẽ chặn và hiển thị thông báo nâng cấp key,
   - khi đã kích hoạt key thì quota lấy theo license.

### Đã hoàn thành trong web (`web/`)

- Bổ sung gói miễn phí 1 tài khoản trong bảng giá nguồn (`tier-1`, giá 0đ).
- Landing + Pricing + Dashboard hiển thị rõ thông điệp:
   - chưa kích hoạt key vẫn dùng được theo gói miễn phí 1 tài khoản,
   - có CTA nhận key miễn phí.
- Thêm endpoint `GET /api/claim-free`:
   - user đã đăng nhập có thể nhận key miễn phí,
   - tránh cấp lặp bằng cách kiểm tra user đã có license `tier-1` hay chưa,
   - ghi audit log `claim-free-license`.
- Thêm endpoint dev seed test (`/api/dev/seed-license`) + script smoke test:
   - phục vụ kiểm tra nhanh luồng activate/heartbeat ở local,
   - có secret guard bằng `DEV_SEED_SECRET`,
   - script smoke đã cải thiện log lỗi HTTP để debug nhanh.
- Sửa callback auth local:
   - cookie auth không còn ép `secure: true` ở localhost (HTTP),
   - tránh lỗi đăng nhập local xong mất session.
- Bổ sung trang `terms` và `privacy` để tránh 404 từ trang đăng nhập.

### Ổn định môi trường dev web

- Đã nâng Next.js lên `14.2.35`.
- Đã xử lý lỗi dev runtime dạng `Cannot find module './276.js'` bằng quy trình:
   - kill toàn bộ dev server cũ,
   - xoá `.next` + `node_modules` + lockfile,
   - cài lại dependency sạch,
   - chạy lại dev server đơn lẻ.

### Ghi chú vận hành hiện tại

- Web đang chạy ổn định sau khi clean reinstall và build lại.
- Nếu thấy lại lỗi trắng trang/mất CSS/chunk 404 trong dev:
   - dừng tất cả terminal `npm run dev`,
   - chỉ chạy **một** dev server,
   - nếu cần thì xoá `.next` rồi chạy lại.

## 0d. Auto-Update + Supabase/Vercel Song Song (2026-05-08)

### 📍 Tình hình hiện tại

- App desktop: đã có license runtime (activate/heartbeat), free tier 1 quota enforced, UI buttons đầy đủ ✅
- Web: landing/pricing/dashboard hiển thị free tier, 4 API endpoints (activate/heartbeat/claim-free/dev-seed) ready ✅
- **Blocking issue:** Auto-update machinery (code signing, NSIS hardening, release pipeline) chưa production-ready
- **Parallel work:** Supabase project setup + Vercel deployment

### 🔐 Stream 1: Auto-Update Production Hardening

**Mục tiêu:** User bấp "Cập nhật ngay" trong app → tự download + cài + restart. Installer phải ký số (EV cert) để Windows 10/11 không cảnh báo SmartScreen.

**Liên quan files:**
- `app/auto-update.js` — existing skeleton, needs config polish
- `app/package.json` — electron-builder + signing config
- `.github/workflows/release.yml` — CI build + sign + publish

#### Task 1: Lấy EV Code Signing Certificate

**Status:** ✅ **Setup script ready!** Run `app/CODE-SIGNING-SETUP.ps1`

**Các option:**
| Provider | Chi phí | Thời gian | Đặc điểm |
|---|---|---|---|
| **SSL.com** | $330/năm | 1-2 ngày (verified) | Instant issuance, cheap, widely trusted |
| **Sectigo** (DigiCert) | $500-600/năm | 1-2 ngày | Enterprise-grade, slightly more expensive |
| **Dev cert (temp)** | 0đ | instantly | Không ký thực, chỉ test; Windows sẽ warning |

**Quick Start:**
1. Run script: `powershell app/CODE-SIGNING-SETUP.ps1`
2. Follow prompts → select SSL.com
3. Verify danh tính (email verification)
4. Download `.pfx` file
5. Encode cert via script → GitHub secrets
6. Done!

**After cert obtained:**
- Script sẽ guide encode `.pfx` → base64
- Save to `app/cert-github-secret.txt` (easy copy-paste)
- Paste vào GitHub → Settings → Secrets:
  - `SIGNING_CERT_BASE64` = cert file base64
  - `SIGNING_CERT_PASSWORD` = cert password

#### Task 2: Harden Electron-Builder + NSIS Config ✅ **DONE**

**Status:** ✅ **Files updated!**

**Changes made:**
- ✅ Updated `app/package.json`:
  - Added `certificateFile` + `certificatePassword` env vars
  - Added NSIS config: desktop shortcut, start menu shortcut, custom icons
  - Added `installer.nsh` include for NSIS customization
- ✅ Created `app/installer.nsh`:
  - Version info (VIProductVersion, VIFileVersion)
  - Vietnamese language support
  - Finish page option: "Run ZaloMask" checked by default
  - Custom branding
- ✅ Updated `.github/workflows/release.yml`:
  - Auto-detect if cert secrets are set
  - If provided: setup cert file, configure env vars
  - If not provided: build unsigned (for testing)
  - Both paths supported seamlessly

**Next:** When cert is ready, push tag → CI auto-signs

#### Task 3: Test Real Upgrade Flow ⏳ **Ready for test after cert**

**Khi cert ready, test:**
1. Increment version: `26.3.1` → `26.3.2` ở `app/package.json`
2. Commit + tag:
   ```bash
   git add .
   git commit -m 'v26.3.2'
   git tag v26.3.2
   git push origin main --tags
   ```
3. Watch GitHub Actions: installer được build + ký tự động
4. Download từ Release tab
5. Verify: Right-click .exe → Properties → Digital Signatures
   - Should show "ZaloMask" signer
   - NO SmartScreen warning
6. Install + verify auto-update detection works

### ☁️ Stream 2: Supabase + Vercel Setup

**Mục tiêu:** Prod web platform live ở domain (e.g. zalomask.com), Supabase Postgres hosting prod data, Vercel auto-deploy từ GitHub.

**Status:** ✅ **Setup script ready!** Run `SUPABASE-VERCEL-SETUP.ps1`

#### Quick Start

```powershell
# Interactive guide with all steps
powershell .\SUPABASE-VERCEL-SETUP.ps1
```

Script sẽ tự động:
1. Generate Ed25519 key pair (for license signing)
2. Guide từng bước tạo Supabase project
3. Guide migrate database schema
4. Guide connect Supabase auth (Google OAuth)
5. Guide deploy Vercel từ GitHub
6. Guide setup custom domain
7. Test production APIs

#### Manual Checklist (nếu không chạy script)

**Supabase Setup:**
- [ ] Tạo account tại [supabase.com](https://supabase.com)
- [ ] Tạo project mới tên `zalomask-prod` (region closest)
- [ ] Copy connection string: `postgresql://user:pass@db.supabase.co:5432/postgres`
- [ ] Open SQL Editor → paste toàn bộ `web/supabase/migrations/0001_init.sql`
- [ ] Execute → verify bảng exist: `users`, `licenses`, `sessions`, `payments`, `audit_log`
- [ ] Setup Supabase Auth - Google OAuth:
  - Tạo Google OAuth credentials ở [Google Console](https://console.cloud.google.com)
  - Redirect URI: `https://zalomask.supabase.co/auth/v1/callback`
  - Paste Client ID + Secret vào Supabase → Authentication → Google
- [ ] Generate Ed25519 key pair:
  ```bash
  openssl genpkey -algorithm Ed25519 -out zalomask_ed25519.key
  openssl pkey -in zalomask_ed25519.key -pubout -out zalomask_ed25519.pub
  ```
- [ ] Save public key for Vercel env var `LICENSE_PUBLIC_KEY_PEM`

**Vercel Setup:**
- [ ] Sign up [vercel.com](https://vercel.com)
- [ ] Connect GitHub repo
- [ ] Import `PCZaloClone/web` folder
- [ ] Setup env vars (see table below)
- [ ] Deploy → wait for build (5-10 min)
- [ ] Setup custom domain (Vercel → Settings → Domains)

**Env Vars cho Vercel:**

| Variable | Source | Example |
|---|---|---|
| `DATABASE_URL` | Supabase Settings → Database | `postgresql://...` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Settings → API | `https://xxxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Settings → API → anon key | `eyJ...` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google Console | `xxx.apps.googleusercontent.com` |
| `LICENSE_PRIVATE_KEY` | Ed25519 private key (secret) | `-----BEGIN PRIVATE KEY-----...` |
| `LICENSE_PUBLIC_KEY_PEM` | Ed25519 public key | `-----BEGIN PUBLIC KEY-----...` |
| `RESEND_API_KEY` | [resend.com](https://resend.com) (optional) | `re_xxxxx` |
| `SEPAY_API_KEY` | [sepay.vn](https://sepay.vn) | `...` |
| `SEPAY_ACCOUNT_NUMBER` | Your bank account | `123456789` |
| `NODE_ENV` | Fixed | `production` |

**Third-party APIs Setup:**
- [ ] **Resend** (Email sender):
  - Sign up [resend.com](https://resend.com)
  - Copy API key → Vercel env
- [ ] **SePay** (Payment gateway):
  - Sign up [sepay.vn](https://sepay.vn)
  - Link bank account
  - Generate API key → Vercel env
- [ ] **Sentry** (Crash reporting - optional):
  - Sign up [sentry.io](https://sentry.io)
  - Create project (Node.js + React)
  - Copy DSN → app + web

#### Checklist: Supabase Setup

- [ ] Tạo account tại [supabase.com](https://supabase.com) (nếu chưa)
- [ ] Tạo project mới tên `zalomask-prod` (region closest để user)
- [ ] Copy connection string: `postgresql://user:pass@db.supabase.co:5432/postgres`
- [ ] Run migration file: `web/supabase/migrations/0001_init.sql`
  - Open Supabase SQL Editor → paste toàn bộ SQL → Execute
  - Verify bảng exist: `users`, `licenses`, `sessions`, `payments`, `audit_log`

### 📊 Progress Tracking (2026-05-08)

**Auto-Update Stream - COMPLETED:**
- [x] Setup script created: `app/CODE-SIGNING-SETUP.ps1`
- [x] Hardened `app/package.json` with code signing config
- [x] Updated `.github/workflows/release.yml` to handle cert signing
- [x] Created `app/installer.nsh` for NSIS customization
- [ ] **NEXT:** User buys EV cert (SSL.com or Sectigo) — run script when cert arrives

**Supabase/Vercel Stream - COMPLETED:**
- [x] Setup script created: `SUPABASE-VERCEL-SETUP.ps1`
- [x] Ed25519 key pair generation integrated in script
- [ ] **NEXT:** User runs script → follows interactive guide

### 🚦 YOUR ACTION NOW (Immediate)

**Step 1: Auto-Update Code Signing**
```powershell
cd app
powershell .\CODE-SIGNING-SETUP.ps1
```
This will guide you through:
- SSL.com purchase (or use competitor)
- Certificate encoding for GitHub
- Adding 2 secrets: `SIGNING_CERT_BASE64` + `SIGNING_CERT_PASSWORD`

**Step 2: Supabase/Vercel Deployment**

First, create accounts:
- [supabase.com](https://supabase.com)
- [vercel.com](https://vercel.com)
- Buy domain (zalomask.com or similar)

Then run:
```powershell
powershell .\SUPABASE-VERCEL-SETUP.ps1
```
This will guide you through:
- Supabase project creation + database migration
- Google OAuth setup
- Vercel deployment + environment variables
- Custom domain configuration

**Timeline:**
- Auto-Update cert: 1-2 days (SSL.com verification)
- Supabase setup: 15-30 minutes
- Vercel deployment: 5-10 minutes (auto-build)
- DNS propagation: 5-30 minutes

**When complete:** Both app + web live → ready for beta testing!

## 0b. Điều chỉnh kế hoạch (bản áp dụng từ hiện tại)

### Điều chỉnh trọng tâm

- Đóng băng luồng clone desktop legacy (`main.js`) ở mức maintenance-only, không thêm tính năng mới.
- Dồn toàn bộ feature mới vào Web Session v2 (`app/main.v2.js`).
- Ưu tiên tính nhất quán profile: proxy bắt buộc, fingerprint ổn định, backup/restore đầy đủ metadata.

### Việc cần làm tiếp ngay (v2)

1. Bổ sung bộ test smoke cho 4 luồng: tạo profile, mở profile qua proxy, sao lưu 1 profile, sao lưu nhiều profile.
2. Thêm trang "Thông tin profile" để hiển thị fingerprint hiện tại (read-only) cho debug/hỗ trợ.
3. Thêm checksum/signature cho file backup bundle để phát hiện file bị sửa hoặc hỏng.
4. Chuẩn hóa thông báo lỗi proxy theo mã lỗi thân thiện người dùng (timeout/auth/tunnel/dns).
5. Viết script kiểm thử import/export chéo máy với dữ liệu fingerprint + proxy auth.

### Ranh giới phạm vi

- Không mở rộng thêm kỹ thuật patch sâu vào runtime desktop clone trong giai đoạn này.
- Mọi thay đổi liên quan license/web/cloud cần tương thích trực tiếp với metadata profile v2 hiện tại (bao gồm fingerprint/proxy).

## 1. Trạng thái hiện tại

- App Electron tên **ZaX** (`app/package.json` → `"name": "ZaX"`, version 26.3.1).
- Hoạt động: tạo profile clone Zalo, mở nhiều account cùng lúc, proxy riêng từng profile, backup/restore profile ra file JSON.
- Profile được lưu ở `C:\Users\Admin\Documents\PCZaloClone\profiles\`. Dữ liệu Zalo clone ở `%APPDATA%\ZaloData_<cloneId>` và `%APPDATA%\__zalomask_clone_env__\<cloneId>\ElectronSessionData`.

### Bug đã sửa trong `app/main.js`

**Triệu chứng:** Sao lưu profile clone ra JSON, mang sang máy khác import thì vào Zalo vẫn bị bắt quét QR.

**Nguyên nhân:** Khoá AES‑256 (`os_crypt.encrypted_key` trong file `Local State` của Chromium) được Windows DPAPI bảo vệ theo từng user/máy. Code cũ lúc import sinh **khoá AES mới** rồi re‑encrypt cookies, nhưng các blob `v10` trong `SecureLocalstorage.db`, một số entry leveldb… vẫn còn mã hoá bằng khoá AES cũ của máy nguồn → máy đích đọc ra rác → Zalo coi session hỏng → bắt đăng nhập lại.

**Fix:**
- Thêm `cookieKeyB64` (khoá AES gốc đã decrypt) vào file JSON khi export.
- Lúc import: DPAPI‑protect chính khoá đó dưới user hiện tại (helper `applyExistingCookieKeyToZaloRoot`) → giữ nguyên khoá → mọi blob `v10` cũ vẫn đọc được.
- Phụ: thêm `zsvm.bin` vào snapshot, lọc `LOCK` của leveldb, xoá `-wal/-shm/-journal` cũ trước khi viết DB mới, dừng tiến trình Zalo clone trước khi snapshot để WAL kịp checkpoint.
- Tương thích ngược: file JSON cũ (không có `cookieKeyB64`) vẫn import được, fallback về luồng cũ.

**Ghi chú bảo mật:** `cookieKeyB64` là khoá AES‑256 thô. File JSON này về sau cần coi như mật khẩu Zalo — không chia sẻ công khai. Khi web hoá sẽ mã hoá thêm bằng passphrase người dùng.

## 2. Triết lý làm việc

- **Mua sẵn (SaaS) bất kỳ thứ gì không phải lõi.** Mỗi component tự dựng = một con bug tương lai phải tự fix.
- **Một stack duy nhất** cho toàn bộ web/backend/license — không lan man lựa chọn.
- **Phase rõ ràng**, sau mỗi phase có thứ thực sự dùng được.
- **Phải hoàn thiện app PC trước**, web/license/payment làm sau khi app đã ổn định.

## 3. Thứ tự ưu tiên

### Phase 1 — Hoàn thiện ZaloMask (làm trước hết)

**Mục tiêu:** App PC chạy đúng mọi tính năng, ổn định, sẵn sàng tích license.

Việc cụ thể, làm theo thứ tự:

1. **Verify fix backup/restore vừa làm.** Test thực tế: export trên máy A → import trên máy B → mở Zalo phải vào thẳng, không cần QR. Nếu còn lỗi → debug tiếp dựa vào `C:\ProgramData\ZaloMask\work\logs\perf.log`.
2. **Rà silent fail trong `main.js`.** Có ~30‑40 chỗ `try{}catch{}` đang nuốt lỗi. Thêm `perfLog` vào catch để biết khi sai.
3. **Sửa đường dẫn hardcoded.** `C:\Users`, `C:\Windows`, `C:\ProgramData\ZaloMask` — chuyển sang dùng `process.env.SystemDrive`, `process.env.ProgramData`. Hỏng nếu Windows install ở ổ khác.
4. **Sanitize input PowerShell.** Các chỗ build script PS từ `winUser`, `profileName`, `displayName` chỉ escape `'` và backtick — chưa đủ. Cần whitelist ký tự an toàn.
5. **Test toàn diện các luồng** ở UI: tạo profile mới, mở nhiều profile cùng lúc, đổi proxy, xoá profile, sao lưu, khôi phục, web profile. Không có warning/error im lặng.
6. **Tích Sentry** để bắt crash từ xa. Free tier 5k event/tháng đủ giai đoạn đầu.
7. **Tích `electron-updater`** (đã có trong `package.json`). Endpoint host update sẽ làm cùng web ở Phase 4.

**Khi xong Phase 1:** App ổn định, dùng nội bộ + cho beta tester. Chưa thu tiền.

### Phase 2 — Hệ thống license với single‑session

**Mục tiêu:** Khách mua key → activate trên 1 máy. Nếu cùng key activate trên máy 2 → máy 1 tự logout. Đăng nhập web bằng Google.

**Quy tắc nghiệp vụ:**
- 1 key = 1 active session tại một thời điểm.
- Activate máy mới → tự kick máy cũ (không cần khách thao tác gì).
- Mất mạng tạm thời (< 30 phút) không bị kick.
- Hết hạn license → app khoá tính năng, vẫn cho gia hạn từ trong app.

**Cơ chế kỹ thuật:**

1. Mỗi license trong DB có trường `active_session_id` (UUID, có thể null).
2. App khi activate gửi `{key, device_fingerprint}` lên server.
3. Server kiểm key còn sống → tạo `session_id` mới → ghi đè `active_session_id` của license → trả token (Ed25519‑signed) cho client kèm `session_id` đó.
4. Client lưu token, heartbeat 30s/lần lên server kèm `session_id`.
5. Server so `session_id` từ client với `active_session_id` hiện tại trong DB:
   - Khớp → trả `ok`.
   - Khác → trả `kicked` → client đóng Zalo + popup "Tài khoản đang dùng ở máy khác. Đăng nhập lại để dùng ở máy này".
6. Offline grace: nếu client mất mạng, dùng được tiếp 30 phút (chỉ check expiry trong token cached). Quá grace → app yêu cầu mạng.
7. Token có chữ ký server → client không tự sửa expiry được.

**Device fingerprint PC:** SHA‑256 của `MachineGuid` (HKLM\SOFTWARE\Microsoft\Cryptography) + UUID mainboard (`wmic csproduct get UUID`) + serial ổ C. Không dùng MAC vì thay đổi liên tục.

**Backend:** Supabase Postgres + Auth (Google OAuth) + Edge Functions.

**Bảng dữ liệu chính:**
- `users` — Google ID, email, ngày tạo.
- `licenses` — `key`, `user_id`, `plan`, `expires_at`, `active_session_id`, `status` (active/revoked/expired).
- `sessions` — `id`, `license_id`, `device_fingerprint`, `device_name`, `last_seen_at`, `created_at`.
- `payments` — `user_id`, `license_id`, `amount`, `method`, `sepay_txn_id`, `status`.
- `audit_log` — mọi activate / kick / transfer để chống tranh chấp.

### Phase 3 — Web bán hàng + dashboard

**Mục tiêu:** Khách tự mua key, tự quản lý license, không cần liên hệ thủ công.

- Landing trang chủ + bảng giá (1 tháng / 6 tháng / 1 năm hoặc tuỳ).
- Đăng nhập **bằng Google** (Supabase Auth lo hết).
- Khách bấm mua → web hiển thị QR SePay → khách chuyển khoản → SePay webhook về web → web auto sinh key + gửi về email khách.
- Dashboard khách: xem key của mình, xem thiết bị đang active, lịch sử thiết bị từng dùng, gia hạn key.
- Trang admin riêng cho bạn: doanh thu, list khách, search key, ban/revoke key.

### Phase 4 — Code signing + auto‑update + chạy production

- **Mua EV code signing cert** (SSL.com hoặc Sectigo, ~$330/năm). Bắt buộc — không có cert thì SmartScreen của Windows chặn installer, mất 30‑50% khách bước cài.
- **Setup auto‑update**: file installer đã ký + `latest.yml` host trên Cloudflare R2 (gần như miễn phí). `electron-updater` tự download bản mới khi user mở app.
- **Soạn ToS + Privacy + Refund policy** (template tôi sẽ soạn). Có clause: "tính năng phụ thuộc Zalo, nếu Zalo block thì extend license thay vì refund full".
- **Beta đóng** ~30 user 2‑3 tuần để bắt edge case (antivirus false positive, DPAPI lạ, Zalo update).
- **Nộp installer lên VirusTotal + Microsoft submission portal + Kaspersky/Bitdefender** xin whitelist.
- Public launch.

### Phase 5 — Mobile (làm sau, không song song)

- **Chỉ Android.** iOS bỏ qua vì sandbox không cho clone.
- License system tái dùng nguyên (cùng API, chỉ đổi cách lấy fingerprint: SSAID + Build hash).
- Logic clone Zalo Android phải làm lại từ đầu — không tái dùng được code PC.
- Chỉ động đến mobile sau khi PC chạy ổn 2‑3 tháng và có doanh thu đều.

## 4. Stack tổng

| Hạng mục | Lựa chọn |
|---|---|
| Frontend web | Next.js trên Vercel |
| Backend | Supabase (Postgres + Auth + Edge Functions) |
| Đăng nhập | Google OAuth qua Supabase Auth |
| Thanh toán VN | SePay (QR chuyển khoản, webhook) |
| Thanh toán quốc tế (nếu cần) | Paddle (tự xử VAT giùm) |
| Email | Resend |
| Crash report | Sentry |
| CDN cho installer | Cloudflare R2 |
| Code signing | SSL.com EV cert |
| App PC | Electron (giữ nguyên) |
| App mobile (sau) | Tạm chưa quyết — có thể React Native |

## 5. Chi phí cố định ước tính

| Khoản | Tiền |
|---|---|
| Code signing cert (1 năm) | ~$330 (~8 triệu ₫) |
| Domain | ~250k ₫/năm |
| Vercel / Supabase / Sentry / Resend / SePay | 0 ₫ giai đoạn đầu (free tier đủ vài nghìn user) |
| Cloudflare R2 (host installer) | vài chục nghìn ₫/tháng |

→ Khởi đầu **~9 triệu ₫/năm chi phí cố định**, scale dần theo lượng khách.

## 6. Ghi chú quan trọng cần nhớ

- **Khoá `cookieKeyB64`** trong file JSON sao lưu = mật khẩu Zalo. Đối xử y như vậy. Phase 3 sẽ mã hoá file thêm bằng passphrase người dùng.
- **Zalo có thể update bất kỳ lúc nào** làm chết logic backup. Cần:
  - Quỹ khẩn cấp đủ refund 1‑2 tháng doanh thu.
  - ToS clause "extend thay vì refund full khi Zalo block".
  - Telemetry đầy đủ để biết ngay khi nào hỏng.
- **`audit_log` lưu mọi thao tác** activate/kick/transfer để chống tranh chấp với khách.
- **Antivirus rất dễ flag false positive** vì app tạo Windows user + đụng DPAPI + ghi vào DB Chromium → mỗi build mới phải submit whitelist các AV phổ biến.
- **App yêu cầu admin** → một số khách dùng máy công ty không có quyền admin sẽ không cài được. Cần ghi rõ trên trang bán.

## 7. Phân vai

**Việc Claude (tôi) sẽ làm trong các session tiếp theo:**
- Viết code tất cả phase trên (app, web, backend).
- Bạn copy‑paste hoặc duyệt diff.
- Soạn template ToS / Privacy / Refund.
- Hướng dẫn từng bước nếu chỗ nào bạn cần thao tác tay.

**Việc bạn phải tự lo, không thể outsource:**
- Đăng ký các dịch vụ (Supabase, Vercel, Cloudflare, SePay, Sentry, Resend).
- Mua EV code signing cert (verify danh tính cá nhân/doanh nghiệp).
- Mua domain.
- Đăng ký hộ kinh doanh hoặc doanh nghiệp (cần để mở SePay nhận tiền chính danh).
- Quyết giá bán + chính sách refund cụ thể.
- Hỗ trợ khách (Zalo / Facebook chat) — giai đoạn đầu phải tự nghe khách than để biết app còn lỗi gì.

## 8. Việc cần làm tiếp ngay sau khi đọc file này

**Để bắt đầu Phase 1 (hoàn thiện app):**

1. Test fix backup/restore vừa làm trên 2 máy thật. Báo lại kết quả.
2. Trả lời tôi: muốn xử mục nào trước trong Phase 1?
   - (a) Rà silent fail + log đầy đủ.
   - (b) Test toàn diện các luồng UI để liệt bug còn sót.
   - (c) Sửa hardcoded path + sanitize PowerShell.

**Trước khi vào Phase 2 (license + web), bạn cần chuẩn bị:**

- Tài khoản Supabase (supabase.com) — tạo project mới tên `zax-license`.
- Tài khoản Vercel (vercel.com) — nối GitHub.
- Mua 1 domain trên Namecheap hoặc PA Vietnam (ví dụ `zax.vn`, `zax.app`).
- Tài khoản SePay (sepay.vn) — gắn với tài khoản ngân hàng nhận tiền.

Khi nào đến Phase 2 tôi sẽ nhắc lại.

## 8b. Bảng giá đã chốt (lưu để dùng cho Phase 3)

> Các gói bán theo số lượng tài khoản Zalo cùng lúc, không giới hạn thời gian giữa các gói trong cùng tier.

| Gói | 1 tháng | 3 tháng | 6 tháng | 1 năm |
|---|---|---|---|---|
| 6 Zalo | 199k | 499k | 999k | 1499k |
| 15 Zalo | 399k | 799k | 1499k | 2499k |
| 25 Zalo | 499k | 999k | 1999k | 2999k |
| 50 Zalo | 799k | 1499k | 2999k | 3999k |
| 100 Zalo | 999k | 1999k | 3999k | 5999k |

**Liên hệ bán hàng / hỗ trợ:**
- SĐT / Zalo: 0981897779
- Telegram: @zalomask

## 8c. Trạng thái dự án — chốt sổ ngày 2026-05-07

### Đã làm xong

**Desktop (`app/`):**
- Multi-account Zalo PC chạy song song qua patch `app.asar` (ổn định từ trước)
- Privacy shim ẩn typing/seen/received (đã có)
- Proxy per-profile HTTP/SOCKS5 (đã có)
- Backup/restore JSON với `cookieKeyB64` (fix DPAPI hôm 2026-05-06)
- **Mới hôm nay:** Live runtime collector ([app/clone-runtime-collector.js](app/clone-runtime-collector.js)) inject vào MAIN world Zalo, đọc canonical state từ `$$afmc.zStorage` + localStorage thay vì cào file mã hoá
- **Mới hôm nay:** SessionStore abstraction ([app/session-store.js](app/session-store.js)) + LocalProvider (file) + SupabaseProvider stub
- **Mới hôm nay:** Format export v4 (cắt v3) — chỉ canonical snapshot + cookies + cookieKeyB64, gọn hơn rất nhiều
- **Mới hôm nay:** Pin localStorage trong preload trước khi Zalo bundle chạy → diệt race condition `imei`
- **Mới hôm nay:** Tab "Đồng bộ đám mây" trong UI Electron với nút Ghi seed / Đẩy / Kéo cloud
- **Mới hôm nay:** Auto-update cơ chế ([app/auto-update.js](app/auto-update.js)) — poll GitHub Releases mỗi giờ, badge "⬆ Bản mới" + modal tải/cài
- **Mới hôm nay:** Rebrand `ZaX` → `ZaloMask`, homepage `https://zalomask.com`, electron-builder NSIS config
- **Mới hôm nay:** GitHub Actions [.github/workflows/release.yml](.github/workflows/release.yml) — push tag `v*` → CI build NSIS + tạo Release

**Web (`web/`):**
- **Mới hôm nay:** Next.js 14 App Router + TypeScript + Tailwind scaffold
- **Mới hôm nay:** Landing page + bảng giá 5 gói (đọc từ `lib/plans.ts`)
- **Mới hôm nay:** Checkout page với QR SePay + memo format `ZM <userId8> <tier> <duration>`
- **Mới hôm nay:** Customer dashboard (license + thiết bị active)
- **Mới hôm nay:** Admin dashboard (revenue + license + user)
- **Mới hôm nay:** Google OAuth qua Supabase Auth
- **Mới hôm nay:** API `/api/activate` (Electron app gọi để activate key, trả Ed25519 token)
- **Mới hôm nay:** API `/api/heartbeat` (single-session check 30s/lần)
- **Mới hôm nay:** API `/api/sepay-webhook` (SePay → tạo key + email Resend)
- **Mới hôm nay:** Supabase migrations 5 bảng + RLS policies + trigger sync auth.users
- **Mới hôm nay:** Ed25519 license token (zero-deps node:crypto, không phụ thuộc lib JWT)
- **Mới hôm nay:** Setup README đầy đủ ở `web/README.md`

### Việc tiếp theo (theo thứ tự ưu tiên)

#### Tuần 1 — Lên cloud chạy thật

**Bạn (không thể outsource):**
1. Tạo GitHub repo public, replace `REPLACE_GITHUB_OWNER`/`REPLACE_GITHUB_REPO` ở 3 chỗ:
   - `app/package.json` → `build.publish`
   - `config.json` → `github`
   - `web/app/page.tsx` → link tải về
2. Tạo Supabase project `zalomask-prod`, paste `web/supabase/migrations/0001_init.sql` vào SQL Editor.
3. Trong Supabase Auth → bật Google OAuth (cần Google Cloud Console tạo OAuth client trước).
4. Mua domain `zalomask.com` (Namecheap hoặc PA Vietnam).
5. Đăng ký SePay (sepay.vn), gắn ngân hàng nhận tiền, lấy webhook secret.
6. Đăng ký Resend (resend.com), verify domain `zalomask.com` để gửi email.
7. Đăng ký Vercel, connect GitHub repo, set Root Directory = `web/`.
8. Sinh Ed25519 keypair (lệnh ghi trong `web/README.md` mục 3), nạp vào env Vercel.
9. Paste tất cả env (anon key, service role, SePay secret, Resend key, Ed25519 keys, ADMIN_EMAILS=seringuyen0506@gmail.com) vào Vercel Project Settings.
10. Deploy `web/` lên Vercel, trỏ DNS `zalomask.com` về Vercel.
11. Cấu hình SePay webhook URL = `https://zalomask.com/api/sepay-webhook` với header `Authorization: Apikey <secret>`.

**Mình (Claude) sẽ làm tiếp khi xong các bước trên:**
12. Embed Ed25519 PUBLIC key vào Electron app làm hằng số (`app/license-public-key.js`).
13. Viết `app/license-client.js`: gọi `/api/activate` lúc nhập key + `/api/heartbeat` mỗi 30s, lưu token offline cho grace 30 phút khi mất mạng.
14. Thêm tab "License" vào UI Electron: input key, hiển thị trạng thái (active/expired/kicked), nút gia hạn (deeplink sang `zalomask.com/dashboard`).
15. Gate tính năng `add-clone-profile`: kiểm tra số profile hiện có vs `accountQuota` của license trước khi cho tạo mới.

#### Tuần 2 — Beta đóng

**Bạn:**
- Mời 20-30 user test (ưu tiên người làm sales/CSKH chạy nhiều account).
- Thu feedback: bug import sang máy mới, tốc độ load, false positive AV.
- Nộp installer lên VirusTotal + Microsoft submission portal + Kaspersky/Bitdefender xin whitelist.

**Mình:**
16. Tích Sentry — bắt crash từ xa (free tier 5k event/tháng).
17. Soạn ToS + Privacy + Refund policy (template tiếng Việt). Có clause "extend khi Zalo block thay vì refund".
18. Thêm trang `/terms`, `/privacy`, `/refund` trong web.
19. Audit log UI cho admin: search theo email, xem lịch sử activate/kick.
20. Endpoint `/api/admin/revoke` để bạn ban key tay khi gặp scam.

#### Tuần 3-4 — Public launch

**Bạn:**
- Mua EV code signing cert (SSL.com hoặc Sectigo, ~$330/năm). Dán vào GitHub Actions secret `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`. Edit `release.yml` enable signing. Lúc đó SmartScreen sẽ không