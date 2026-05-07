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

## 0e. HANDOFF CHO CLAUDE (TỪ TRƯA ĐẾN TỐI 2026-05-08)

Mục tiêu phần này: đọc nhanh 1 lần là biết chính xác đã làm gì, còn gì dang dở, và bắt đầu từ đâu.

### A. Những việc đã làm xong

1) GitHub + deploy pipeline cơ bản
- Đã khởi tạo git repo local, push thành công lên:
   - https://github.com/lenguyenkieuhan1k-hue/PCZaloClone
- Đã thêm ignore dữ liệu local/nhạy cảm:
   - `.gitignore` bỏ qua `profiles/`, `**/.env.local`, `web/supabase/.temp/`, `web/client_secret_*.json`, các file export JSON.

2) Web auth Google
- Đã sửa lỗi env client không đọc được do dynamic access `process.env[name]`:
   - vá ở `web/lib/supabase.ts`.
- Đã sửa callback OAuth để xử lý cả PKCE + implicit:
   - thay route cũ bằng page client `web/app/auth/callback/page.tsx`.
- Đã sửa header login bị stale sau khi login:
   - ép render theo request ở `web/app/layout.tsx` với `dynamic = 'force-dynamic'`.

3) UI/UX web
- Đã bỏ box cảnh báo vàng ở trang pricing.
- Đã sửa description SEO thành: “Quản lý nhiều tài khoản Zalo.”

4) Thanh toán SePay
- Đã cấu hình hiển thị QR theo env bank ở checkout.
- Đã chặn placeholder env để tránh render QR lỗi:
   - vá ở `web/app/checkout/[plan]/page.tsx`.
- Đã thêm auto-check trạng thái thanh toán ngay trên trang checkout:
   - API mới: `web/app/api/payment-status/route.ts`
   - Client poll mới: `web/app/checkout/[plan]/PaymentWatcher.tsx`
   - Khi thấy `paid` sẽ tự redirect về dashboard.

5) Webhook SePay
- Đã hỗ trợ nhận secret từ header API Key và cả query param fallback:
   - vá ở `web/app/api/sepay-webhook/route.ts`.
- Hiện khuyến nghị chạy chuẩn production theo API Key header của SePay + env secret trùng nhau.

6) Keypair license
- Đã tạo keypair Ed25519 mẫu để user dán lên Vercel.
- User đã được hướng dẫn đúng format PEM multiline cho 2 biến:
   - `LICENSE_TOKEN_PRIVATE_KEY`
   - `LICENSE_TOKEN_PUBLIC_KEY`

### B. Commit timeline quan trọng

- `79922cd` chore: initial project import
- `ed63042` chore(web): update site description
- `b12d368` fix(webhook): support secret via query param
- `3ade19e` fix(web): dynamic header auth and guard placeholder payment env
- `bd77554` feat(web): auto-check sepay payment status on checkout

### C. Những thứ chưa xong / cần hoàn thiện

1) Xác nhận E2E giao dịch thật đã "tự cấp key"
- Cần test thực 1 giao dịch mới sau commit `bd77554`:
   - chuyển khoản đúng memo trên checkout,
   - chờ webhook,
   - xác nhận `licenses` có row mới,
   - xác nhận dashboard hiển thị key mới.

2) App desktop verify token production
- `config.json` hiện còn trống `licensePublicKeyPem`.
- Phải dán public key đúng cặp với private key trên Vercel để activate-license chạy thật.

3) Auto-update production
- `app/package.json` vẫn để placeholder `REPLACE_GITHUB_OWNER/REPLACE_GITHUB_REPO` trong build publish.
- Chưa chốt code-sign cert thực tế (EV cert mới ở mức chuẩn bị script).

4) Email gửi key
- Nếu `RESEND_API_KEY` chưa set thì webhook vẫn tạo key nhưng không gửi mail tự động.

### D. Những điểm còn nghi ngờ / rủi ro

1) Idempotency webhook khi SePay retry
- `payments.sepay_txn_id` có unique index, nhưng code hiện chưa handle mềm trường hợp insert trùng ở mọi nhánh.
- Có thể phát sinh 500 khi webhook bị gọi lại cùng txn (cần harden thêm để trả 200 an toàn).

2) Match memo
- Parser hiện dựa vào format `ZM <id8> <tier-x> <duration>`.
- Nếu user/bank làm biến dạng nội dung chuyển khoản có thể rơi vào pending/manual.

3) Trạng thái UI sau thanh toán
- Đã có polling ở checkout, nhưng vẫn phụ thuộc webhook ghi DB kịp thời.
- Nên bổ sung thông báo “đã nhận tiền nhưng đang xử lý” rõ hơn cho user nếu pending > 1-2 phút.

### E. Trạng thái workspace hiện tại

- Git branch: `main`
- Remote: `origin/main` đã push đủ các commit ở trên.
- Có 1 file local chưa commit: `web/.env.vercel.import` (file hỗ trợ import env, không đẩy lên repo).

### F. Claude nên bắt đầu từ đâu (thứ tự đề nghị)

1) Kiểm thử giao dịch thật và xác nhận DB
- Theo dõi Vercel function logs cho endpoint `/api/sepay-webhook` và `/api/payment-status`.

2) Harden webhook idempotent
- Bọc insert payment theo `sepay_txn_id`, nếu trùng thì trả `ok: true` thay vì ném lỗi 500.

3) Chốt app-license production
- Dán `licensePublicKeyPem` vào `config.json`.
- Test activate từ app thật với key vừa mua.

4) Chốt release production
- Điền owner/repo thật ở `app/package.json` build publish.
- Chạy 1 vòng build installer + update-check nội bộ.


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

## 0f. Handoff 2026-05-08 (đợt 4) — production hardening

### Đã xong trong đợt này

**Web — SePay & checkout:**
- `app/api/sepay-webhook/route.ts` viết lại với **idempotency**:
  - Check `sepay_txn_id` trước mọi insert. Nếu giao dịch đã `paid` + có `license_id` → return ok=true với licenseId, không tạo lại.
  - `upsertPaymentRow()` helper update in-place khi row tồn tại, insert mới khi chưa có; bắt lỗi unique-constraint thành audit log thay vì 500.
  - Memo regex tolerate `tier-6` lẫn `tier6` (auto-correct).
  - Mọi nhánh failure (tier sai, số tiền thiếu, ambiguous user, license-insert lỗi) đều return 2xx + ghi audit log → SePay không retry-bomb.
- `app/api/payment-status/route.ts` thêm `licenseId` vào response để PaymentWatcher redirect chính xác.
- `app/checkout/[plan]/PaymentWatcher.tsx` viết lại:
  - Polling 6s/lần qua `setTimeout` (không leak interval khi component unmount).
  - **Timeout 10 phút** → hiển thị CTA "Liên hệ hỗ trợ Zalo 0981897779".
  - Khi `paid` → `router.replace("/dashboard?paid=<licenseId>")`.
- `app/dashboard/page.tsx` đọc `searchParams.paid` / `?msg` → render success banner xanh khi vừa thanh toán xong.

**App — License & auto-update:**
- `main.v2.js::activate-license` thông báo lỗi rõ tiếng Việt khi `licensePublicKeyPem` thiếu.
- `main.v2.js::license-heartbeat` cũng có guard tương tự — không spam server khi config sai.
- `bootLicenseRuntime()` log warning vào `app-runtime.log` nếu `licensePublicKeyPem` rỗng hoặc `config.json.github.owner|repo` còn `REPLACE_*` placeholder.

**Repo housekeeping:**
- `app/package.json` truncate lần thứ 3 → restore lại đầy đủ (giữ `customSign.js`, `installer.nsh`, NSIS shortcut config user mới thêm).
- `web/lib/supabase.ts` truncate → restore.

### Chưa xong (cần làm tiếp)

1. Migration `0002_web_sessions.sql` (legacy slot, hiện giữ free-tier index) chưa chạy lên Supabase production.
2. Email "key sắp hết hạn" chưa wire (Resend cron).
3. `/api/admin/revoke` chưa có.
4. `/changelog` từ GitHub Releases API chưa làm.
5. Offline grace period 30 phút cho heartbeat chưa làm.
6. `/terms`, `/privacy` vẫn placeholder.
7. `installer.nsh` + `customSign.js` reference trong package.json nhưng chưa có file → electron-builder fail.

### Rủi ro còn lại (production)

- Memo SePay nếu khách gõ sai nặng (mất `ZM` đầu) → rơi pending, admin xử thủ công. Đã ghi log payment.
- Heartbeat 30s — Vercel cold-start chậm > 30s có thể gây kicked giả. Cần monitor.
- `app-runtime.log` không rotate.
- PaymentWatcher phụ thuộc cookie `sb-access-token` còn hạn (1h sau login).

### Bước tiếp ưu tiên cao nhất (P0 — không launch được nếu thiếu)

1. [MANUAL] Tạo Supabase project, paste `0001_init.sql` + `0002_web_sessions.sql`.
2. [DONE] File build reference đã đủ: `app/installer.nsh` tồn tại, đã thêm `app/customSign.js` no-op để electron-builder không fail vì thiếu file.
3. [DONE/MANUAL] Đã paste public key vào `config.json::licensePublicKeyPem`. Còn bước manual: đảm bảo `LICENSE_TOKEN_PRIVATE_KEY` trên Vercel phải là private key cùng cặp với public key đã commit.
4. [DONE] Đã replace placeholder `REPLACE_GITHUB_OWNER/REPO` trong `app/package.json::build.publish` + `config.json::github` thành `lenguyenkieuhan1k-hue/PCZaloClone`.

### P1 (cần để khách dùng smooth)

5. Soạn `/terms` + `/privacy` tiếng Việt thật.
6. `/api/admin/revoke` + UI nút Revoke trong `/admin`.

### P2 (nice to have)

8. `/changelog` từ GitHub Releases API.
9. Email reminder "key sắp hết hạn 7 ngày".
10. Offline grace period heartbeat.
11. Sentry crash report.

### Verification đã làm trong đợt này

- `node --check` 5 file Electron active: PASS.
- `python3 -c "json.load"` 4 file JSON config: PASS.
- `tsc --noEmit -p tsconfig.check.json` (exclude stale `.next/types`): PASS — 0 lỗi.
- Manual code review: tất cả nhánh idempotency của sepay-webhook trả 2xx (xác minh bằng đọc code).

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

**Mục tiêu:** Khách mua key → activate trên 1 máy. Nếu c
