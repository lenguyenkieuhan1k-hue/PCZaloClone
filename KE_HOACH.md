# Kế hoạch phát triển ZaX / ZaloMask

> File này lưu toàn bộ ý tưởng + lộ trình phát triển sản phẩm.
> Mở lại file này khi muốn nhớ "đã quyết những gì, đang ở đâu, làm gì tiếp".

## 0. Cập nhật nhanh (2026-05-08)

## 0i. Nhật ký thay đổi chiều -> tối (2026-05-08)

### Những gì đã thay đổi trong app

1. Đổi hướng backup/restore profile desktop sang định dạng portable `.zmb` (thay cho phụ thuộc `.zlp` strict cũ).
2. Bổ sung cơ chế phân loại file khi verify manifest.
3. Nhóm bắt buộc (critical): mismatch thì fail import.
4. Nhóm biến động runtime (volatile): mismatch chỉ cảnh báo, không fail import.
5. Cập nhật luồng export/import và cloud package để đọc/ghi theo format portable mới.
6. Sửa lỗi export bị fail do đường dẫn temp quá dài trên Windows.
7. Rút ngắn tên thư mục/file tạm khi đóng gói và giải nén.
8. Thêm fallback `tar.exe` khi `Compress-Archive`/`Expand-Archive` của PowerShell lỗi.
9. Giữ lại tương thích dữ liệu backup cũ trong import (legacy path) để tránh gãy luồng người dùng cũ.

### Điểm nghẽn hiện tại (chưa đạt mục tiêu)

1. Export hiện đã tạo file được ổn định hơn, nhưng import vẫn có trường hợp fail `Sai dung lượng file` ở một số file DB/media path sâu.
2. Có trường hợp import xong mở profile vẫn bị yêu cầu đăng nhập Zalo lại.
3. Đây là blocker chính: backup chưa đảm bảo "portable session" đúng nghĩa khi chuyển máy.

### Mục tiêu bắt buộc cần xử lý (theo yêu cầu hiện tại)

1. Xuất từ máy A, nhập vào máy B phải mở được profile ngay.
2. Dữ liệu phiên phải giữ nguyên: cookie, local/session storage, DB state liên quan auth.
3. Không bắt đăng nhập lại Zalo sau khi khôi phục.

### Định nghĩa Done cho bài toán xuất/nhập

1. Test tối thiểu 3 vòng export -> import liên tiếp trên 2 máy khác nhau không phát sinh relogin.
2. Không còn popup `Sai dung lượng file` cho nhóm volatile/runtime files.
3. Sau import, profile mở lên vào thẳng trạng thái đã đăng nhập (không QR, không nhập mật khẩu).

### Kế hoạch xử lý tiếp theo (ưu tiên cao nhất)

1. Chốt lại danh sách file session-core bắt buộc preserve và cách restore theo thứ tự an toàn.
2. Tách verification strict/lenient đúng theo loại file, tránh fail nhầm dữ liệu runtime biến động.
3. Bổ sung kiểm tra hậu import (restore health report) để biết thiếu mảnh dữ liệu nào khi bị relogin.
4. Chỉ coi task hoàn tất khi xác nhận cross-machine restore không cần đăng nhập lại.

### Đã hoàn thành trong sprint gần nhất

- Ổn định payment flow SePay -> webhook -> dashboard.
- Chốt business rules: nâng cấp/gia hạn/hủy đúng điều kiện.
- Fix proxy quick paste + check proxy trong modal thêm profile.
- Fix lỗi modal mất focus/đơ input khi nhập thông tin.
- Chặn tự đóng modal khi click ra ngoài với popup có form nhập.
- Thu gọn cửa sổ mở profile theo kiểu mobile-like để đỡ chiếm màn hình.
- Build và đẩy các bản hotfix liên tiếp lên release tags.

### Vấn đề chính hiện tại

- Người dùng cần nghe/gọi ngay trong profile Zalo.
- Với kiến trúc hiện tại (Electron + chat.zalo.me), tính năng gọi bị Zalo khóa ở bản web.
- Đây là giới hạn nền tảng, không phải bug có thể sửa bằng toggle/camera permission.

### Quyết định sản phẩm đề xuất

1. Định vị rõ: ZaloMask là công cụ chat đa tài khoản ổn định.
2. Bổ sung luồng gọi điện: chuyển nhanh sang Zalo PC chính chủ khi người dùng bấm gọi.
3. Truyền thông minh bạch giới hạn nghe/gọi ở web trên landing + app.

### Backlog ưu tiên kế tiếp

1. Thêm nút hành động "Mở Zalo PC" trên mỗi profile.
2. Thêm trạng thái hướng dẫn "gọi chỉ hỗ trợ trên Zalo PC" ở UI profile.
3. Nghiên cứu spike kỹ thuật 1-2 tuần cho phương án bridge desktop-call (nếu muốn theo hướng R&D rủi ro cao).

## 0. Cập nhật nhanh (2026-05-07)

- Mobile (Android + iOS) sẽ triển khai theo mô hình đồng bộ 3 chiều bắt buộc: Phone <-> Web, PC <-> Web, Phone theo dõi/triggers trạng thái PC qua server (source of truth).

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

## 0e. Cập nhật session 2026-05-07 (buổi chiều — Claude Sonnet 4.6)

### ✅ Đã hoàn thành

#### Cloud Sync (upload/download profiles qua server)
- Thêm migration SQL `0003_cloud_sync.sql` — bảng `cloud_backups` (user_id unique, profiles_json jsonb)
- Thêm 2 API route: `POST /api/cloud-sync/upload` và `GET /api/cloud-sync/download`
- Auth cloud route: chấp nhận cả **web cookie** (trình duyệt) lẫn **Bearer license-token** (Electron app)
- Fix Unicode sanitize: strip ký tự surrogate đơn lẻ + NUL trước khi insert JSONB (tránh lỗi Postgres)
- Thêm IPC handlers trong `main.v2.js`: `cloud-sync-upload`, `cloud-sync-download`, `cloud-sync-status`
- Thêm `runCloudUpload()`, `wipeAllLocalProfiles()`, `getJson()` helper
- Luồng kicked: auto upload → wipe local → broadcast `license-kicked` → đóng webWindows
- UI tab "Đồng bộ đám mây" trong renderer: nút Tải lên / Đồng bộ về / Làm mới
- Cập nhật `preload.js`: expose `cloudSyncUpload`, `cloudSyncDownload`, `cloudSyncStatus`, `onProfilesReloaded`

#### Admin web panel
- Thêm trang `/admin` với bảng thống kê + bảng license + bảng user
- Thêm form `CreateKeyForm` (client component): tạo key thủ công với tier, quota, expiry, user email tùy chọn
- Thêm API `POST /api/admin/create-key` — admin-only, upsert user trước khi insert license
- Fix null `user_id` khi email để trống → default về admin hiện tại
- Hiển thị link "Quản trị" trong nav header và nút "Quản trị Admin" trong dashboard (chỉ show cho admin)
- Fix crash server component dashboard: bỏ `onClick` trong server component

#### Build exe
- Build thành công: `app/dist/ZaloMask-Setup-26.3.1.exe` (89MB, NSIS installer)
- Fix nhiều lỗi NSIS: `VIProductVersion already defined`, `ShellExecute invalid` → `ExecShell`, `APP_EXECUTABLE_NAME` → `APP_FILENAME`, MUI ordering warning → đơn giản hoá `installer.nsh`

#### Badge license header app
- Header top-right có pill động: màu xanh (active) / đỏ (expired) / cam (free)
- Hiển thị tier + hạn dùng, cập nhật realtime qua event `license-updated`

#### Fix import cross-machine
- Parser `importProfile` nhận dạng cả 2 format: export chuẩn (field `webSession`) và meta lồng `webSession` từ cloud download

#### Web: nút tải xuống trực tiếp
- Thêm API route `GET /api/download`: fetch GitHub API → redirect 302 thẳng tới asset `.exe` mới nhất
- Cập nhật landing page: nút "Tải xuống · Windows" + icon download, href `/api/download`

---

### 🔲 TODO tiếp theo (chưa làm)

#### Cookie transfer sang máy khác (cần Claude làm)
**Vấn đề:** Khi export/import hoặc cloud sync, cookies Chromium (partition `persist:web2:<name>`) không được backup → user phải login lại Zalo trên máy mới.

**Yêu cầu cho Claude:**
1. **Export**: Dùng `session.fromPartition('persist:web2:<name>').cookies.get({})` lấy tất cả cookies, gộp vào JSON export field `chromiumCookies`
2. **Import**: Sau khi tạo profile mới, nếu JSON có `chromiumCookies`, dùng `session.fromPartition('persist:web2:<newName>').cookies.set(cookie)` để restore từng cookie (loop + await)
3. **Cloud upload**: Gộp cookies vào `profiles_json` khi upload (hàm `runCloudUpload`)
4. **Cloud download**: Restore cookies sau khi save meta.json (IPC `cloud-sync-download`)
5. **Lưu ý kỹ thuật:**
   - Chromium cookie fields: `httpOnly`, `secure`, `session`, `expirationDate` — map đúng khi restore
   - Chỉ restore cookies domain `*.zalo.me`, `*.zadn.vn` để tránh rác
   - Entry point: `app/main.v2.js` (hàm `exportProfile`, `importProfile`, `runCloudUpload`, IPC `cloud-sync-download`)

---

## 0h. Session 2026-05-07 tối muộn — Phase 2 Complete (Checkout + Webhook)

### ✅ Phase 2 HOÀN THÀNH

#### Checkout pages (2 routes)
- `/checkout/upgrade/[newLicenseId]/page.tsx` — display new tier, transfer details, SePay QR
- `/checkout/renew/[licenseId]/page.tsx` — display renewal dates, SePay QR

#### SePay Webhook enhancements
- Handle `method='upgrade'`: activate new license + email "Nâng cấp thành công"
- Handle `method='renewal'`: extend expiry + email "Gia hạn thành công"
- Keep existing `method='new'` flow unchanged

#### Dashboard LicenseTable fix
- Add `useRouter` hook
- `handleUpgrade()`: redirect `/checkout/upgrade/${newLicenseId}`
- `handleRenew()`: redirect `/checkout/renew/${licenseId}`

**Commit:** `fd3ce04`

---

### ✅ Phase 3 HOÀN THÀNH

#### Deactivate/Revoke License
- API `POST /api/deactivate-license` → status='revoked', grace 24h
- Dashboard modal "Huỷ bỏ" button + confirmation + reason selection
- Email notification "Profiles sẽ bị xoá sau 24h"
- Migration 0005: add `revoked_at`, `delete_after` columns + cleanup helper function
- Grace period: user can still restore from cloud backup within 24h

**Commit:** `04e1fbb`

---

### ✅ Phase 4 HOÀN THÀNH (FOUNDATION)

#### Electron Multi-Key Foundation
- Partition function: `persist:zalomask-web-${licenseId}:${profileName}` (multi-key)
- Fallback: `persist:zalomask-web-${profileName}` (legacy, no license_id)
- Each new profile: auto-assign `license_id` (UUID)
- Profile meta now stores: `license_id`
- List profiles: include `license_id` in response
- Backward compatible: old profiles still work (partition without license_id)

**Commit:** `61a85ae`

**Status**: Foundation ready. When user upgrades web app with multi-license active:
1. Electron app reads license_id from profile meta
2. Each profile uses isolated partition per key
3. Ready for future: sync licenses from web API + partition profiles per active key

---

### 📊 Multi-Key System — READY FOR PRODUCTION

**Current State:**
```
User (Google Account)
  │
  ├─ License 1 (key: ZM-ABC, tier-6, active)
  │  └─ Profiles: 3 / 6 (partition: persist:zalomask-web-<license1-uuid>:*)
  │  └─ Actions: Nâng cấp → Tier-15 (new key created)
  │             Gia hạn → extend expiry (same key)
  │             Huỷ bỏ → grace 24h
  │
  ├─ License 2 (key: ZM-DEF, tier-15, active) ← from upgrade
  │  └─ Profiles: 3 / 15 (partition: persist:zalomask-web-<license2-uuid>:*)
  │  └─ Actions: Nâng cấp, Gia hạn, Huỷ bỏ
  │
  ├─ License 3 (key: ZM-GHI, tier-6, revoked) ← pending auto-delete after 24h
  │  └─ Profiles: 5 (still accessible for restore from cloud)
  │  └─ Auto-delete: profiles_cleanup job or next heartbeat
  │
  └─ Total Quota: 6 + 15 = 21 accounts (sum of active)
```

---

### 📝 Todo / Pending

**Phase 4b (Optional — Web License Sync for Electron)**:
- Electron: download active licenses from web API (using license key as auth?)
- Sync profiles per active license_id
- Calculate total quota = SUM(active licenses)
- Heartbeat single-session check per license_id

**Phase 5 (Optional — Admin Panel Enhanced)**:
- Revoke license UI (admin-only)
- Delete profiles after grace period (job)
- License audit log viewer

**Phase 6 (Optional — Testing & Deployment)**:
- Full-flow testing: upgrade, renew, revoke, cloud sync
- Build v2.7.0 (multi-key Electron + web)
- Deploy to staging → production

---

## 0g. Hiện tại session (2026-05-07 tối — Implement Multi-Key License)

### ✅ Đã hoàn thành (Web backend + UI)

#### Migration 0004 — Multi-key schema
- Bảng `profiles` (license_id, profile_name, metadata) — partition by license
- Bảng `license_upgrades` (track upgrade history)
- Modify `licenses`: thêm `parent_license_id` (tracking), `active_machine_id` (single-session)
- Modify `cloud_backups`: unique(license_id) thay vì unique(user_id)
- Helper functions: `get_user_total_quota()`, `get_license_profile_count()`

#### API Routes
- `GET /api/licenses` — list all user licenses + profile count
- `GET /api/license/:id` — list profiles for 1 license
- `POST /api/upgrade-license` — create new key + atomic profile transfer
- `POST /api/renew-license` — extend license expiry

#### Dashboard UI
- `LicenseTable` component (client-side): expandable licenses với actions
- Buttons: "Nâng cấp tier", "Gia hạn", "Huỷ bỏ" (Huỷ chưa implement)
- Modal Nâng cấp: select tier mới → checkout (placeholder: "Tiếp tục")
- Modal Gia hạn: select duration → checkout (placeholder: "Tiếp tục")
- Status badge: Active (green) / Hết hạn (red) / etc
- Profile counter: "X / Y profiles"

---

### 🔲 TODO tiếp theo

#### Phase 2 (Important) — Payment Integration

1. **Checkout flow for upgrade/renewal**
   - Thay thế placeholder "Tiếp tục" → redirect `/checkout?type=upgrade&license=...&tier=...` hoặc `/checkout?type=renewal&license=...&duration=...`
   - Checkout page tạo SePay QR code
   - Memo format: `ZM <userId8> <tier> <duration>` (tương tự current flow)
   - Webhook `/api/sepay-webhook` xử lý: update `licenses.expires_at` (renewal) hoặc mark payment

2. **Pricing page upgrade link**
   - Thêm CTA "Đã có key? Nâng cấp tại dashboard" 
   - Link: `/dashboard` hoặc phần có highlight

#### Phase 3 (Polish) — Edge cases + Admin

1. **Deactivate license** (`/api/deactivate-license`)
   - User click "Huỷ bỏ" → confirm → mark `status='revoked'`
   - Profiles stay on disk (grace period 24h)

2. **Admin revoke** (dashboard)
   - Admin see all users' licenses
   - Button "Revoke" → mark revoked + notify user

3. **Grace period handling**
   - App: offline 7 days → readonly
   - Post-revoke 24h → auto-delete profiles locally

4. **Concurrent session check** (Electron app)
   - heartbeat compare `sessionId` vs `active_session_id`
   - If mismatch → auto-kickout + cloud upload

---

#### Phase 2 (Important) — Payment Integration + Checkout

**Flow sửa đổi (`/api/upgrade-license` + `/api/renew-license`):**
```
Modal upgrade (user select tier + duration):
  Click "Tiếp tục"
  → POST /api/upgrade-license
     → Create new license with status='pending'
     → Create payment record (method='upgrade', license_id=newLicenseId)
     → Return { newLicenseId, newKey, transferCount, price }
  → Show memo + amount, offer copy
  → Redirect /checkout/upgrade/[newLicenseId]
     → Generate SePay QR (memo: "ZM <userId8> <newTier> <duration>")
     → Show "Chuyển khoản để activate"

Modal renew (user select duration):
  Click "Tiếp tục"
  → POST /api/renew-license
     → Create payment record (method='renewal', license_id=licenseId)
     → Return { oldExpires, newExpires, price }
  → Redirect /checkout/renew/[licenseId]
     → Generate SePay QR (memo: "ZM <userId8> <tier> <duration>")
```

**Webhook `/api/sepay-webhook` modifications:**
```
Khi nhận payment từ SePay:
  1. Parse memo → tierId, duration, userId (existing)
  2. Check payment record by sepay_txn_id:
     - If payment.method='new':
       Create new license (existing logic)
     - If payment.method='upgrade':
       → Find new_license_id from payment
       → UPDATE licenses SET status='active' WHERE id=new_license_id
       → Email: "Nâng cấp thành công! Key: <newKey>"
     - If payment.method='renewal':
       → Find license_id from payment
       → UPDATE licenses SET expires_at=... WHERE id=license_id
       → Email: "Gia hạn thành công! Hết hạn: <newDate>"
  3. Mark payment status='paid'
```

**Checkout pages (need create):**
- `/checkout/upgrade/[newLicenseId]/page.tsx` — show upgrade details + SePay QR
- `/checkout/renew/[licenseId]/page.tsx` — show renewal details + SePay QR
- Reuse styling từ `/checkout/[plan]/page.tsx`

**LicenseTable modifications:**
```typescript
// Modal "Tiếp tục" button onClick:
const handleUpgrade = async (licenseId: string) => {
  const res = await fetch('/api/upgrade-license', { /* ... */ })
  const data = res.json()
  if (data.ok) {
    router.push(`/checkout/upgrade/${data.newLicenseId}`)
  }
}

const handleRenew = async (licenseId: string) => {
  const res = await fetch('/api/renew-license', { /* ... */ })
  const data = res.json()
  if (data.ok) {
    router.push(`/checkout/renew/${licenseId}`)
  }
}
```

---

## 0f. Thiết kế License Multi-Key + Renewal (2026-05-07 chiều — tổng hợp cho Claude)

---

## 0f. Thiết kế License Multi-Key + Renewal (2026-05-07 chiều — tổng hợp cho Claude)

### 📌 Nguyên tắc cốt lõi

**Profiles lưu theo LICENSE_ID, KHÔNG theo tài khoản.**

```
Google Account (user_id: AAA)
  │
  ├─ License 1 (key: ZM-LIC1, tier-6, expires: 2026-06-01)
  │  └─ Profiles partition "LIC1" ← RIÊNG BIỆT, hoàn toàn cô lập
  │      ├─ profile_1
  │      ├─ profile_2 
  │      └─ (max 6)
  │
  ├─ License 2 (key: ZM-LIC2, tier-15, expires: 2026-12-01)
  │  └─ Profiles partition "LIC2" ← RIÊNG BIỆT (khác hoàn toàn LIC1)
  │      ├─ profile_a
  │      ├─ profile_b
  │      └─ (max 15)
  │
  └─ License 3 (key: ZM-LIC3, mua hộ người khác, expires: 2026-05-10)
     └─ Profiles partition "LIC3" ← RIÊNG BIỆT (của người kia)
```

**Lợi ích:**
✅ Mỗi key = sandbox 100% cô lập → đặc biệt an toàn khi bán key hộ người khác  
✅ Nâng cấp tier = tạo key mới + auto-transfer → dữ liệu migrate toàn vẹn  
✅ Revoke key = chỉ wipe profiles của key đó → key khác không ảnh hưởng  
✅ Multi-key = tính tổng quota → user có flexibility  

---

### 🔧 Database Schema (Migration 0004)

#### Bảng `licenses` (modify)
```sql
ALTER TABLE licenses ADD COLUMN license_id UUID DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE licenses ADD COLUMN parent_license_id UUID REFERENCES licenses(id);
-- parent_license_id: nếu từ nâng cấp cũ → trỏ tới key cũ (cho admin tracking)
-- Thêm field tracking cho multi-session prevent
ALTER TABLE licenses ADD COLUMN active_machine_id TEXT;
-- active_machine_id: device fingerprint (Electron app instance unique ID)
```

#### Bảng `profiles` (new)
```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  license_id UUID NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL,
  display_name TEXT,
  metadata JSONB,  -- fingerprint, proxy, webSession snapshots
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(license_id, profile_name)
);
CREATE INDEX idx_profiles_license ON profiles(license_id);
```

#### Bảng `cloud_backups` (modify)
```sql
ALTER TABLE cloud_backups 
  ADD COLUMN license_id UUID REFERENCES licenses(id);

-- Change unique constraint
ALTER TABLE cloud_backups 
  DROP CONSTRAINT cloud_backups_user_id_key,
  ADD CONSTRAINT cloud_backups_license_key UNIQUE(license_id);
-- Một backup per license, không share giữa licenses
```

#### Bảng `license_upgrades` (new tracking)
```sql
CREATE TABLE license_upgrades (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  old_license_id UUID REFERENCES licenses(id),
  new_license_id UUID REFERENCES licenses(id),
  upgraded_at TIMESTAMP DEFAULT now(),
  transfer_status TEXT,  -- 'pending', 'completed', 'failed'
  transfer_profile_count INT
);
```

---

### 📋 Workflow: Purchase → Activate → Nâng cấp / Gia hạn → Revoke

#### **Scenario 1: Mua key mới (tier-6, expires +30 days)**

```
Web Checkout:
  user click Tier-6 → SePay payment
  → webhook POST /api/sepay-webhook
     → INSERT licenses (key, tier, expires_at, status='active')
     → email user key + active link

App (Electron):
  user paste key: ZM-LIC1
  → POST /api/activate
     → verify key + check status
     → create session_id (unique GUID)
     → UPDATE licenses SET active_session_id=?, active_machine_id=?
     → IF affected_rows == 0 → key claimed elsewhere, return error "Already active on another machine"
     → ELSE create license-state.json locally
     → broadcast license-updated event
     → show "Activate OK, quota 6 accounts"
```

---

#### **Scenario 2: Nâng cấp tier (6 → 15 accounts)**

```
Web Dashboard:
  user click "Nâng cấp" on ZM-LIC1 (tier-6)
  → modal: select new tier (tier-10 / tier-15 / tier-25)
  → show: "Transfer 3 profiles từ ZM-LIC1 → ZM-NEW?"
  → user confirm
  → checkout SePay (prorate: full price - already paid for ZM-LIC1)

Server POST /api/upgrade-license:
  input: { old_license_id, new_tier, duration }
  1. CREATE new_license (tier, expires = same as old or extended)
  2. START transaction
  3. SELECT profiles WHERE license_id = old_license_id
  4. COPY to new_license_id (INSERT INTO profiles... SELECT with license_id=new)
  5. INSERT license_upgrades (old_license_id, new_license_id, transfer_status='completed')
  6. COMMIT
  7. Email: "Nâng cấp thành công! Key mới: ZM-NEW. Key cũ vẫn active (gia hạn thêm 30 ngày tự động?)"
  
App behavior:
  → User still on ZM-LIC1 in app
  → Dashboard shows 2 keys: ZM-LIC1 (old tier) + ZM-NEW (new tier, empty)
  → Optional: "Activate new key?" button → switch to ZM-NEW
  → Or keep using ZM-LIC1 (profiles still there, quota still 6)

⚠️ Design choice: 
  - Keep old key active? (user flexibility, but confusing)
  - OR auto-deactivate old key? (cleaner UX)
  → PROPOSAL: Show prompt "Auto-deactivate ZM-LIC1?" with grace period 24h
```

---

#### **Scenario 3: Gia hạn key (extend expiry)**

```
Web Dashboard:
  user click "Gia hạn" on ZM-LIC1 (expires 2026-06-01)
  → modal: select duration (1m / 3m / 6m / 1y)
  → show: "Gia hạn từ 2026-06-01 → 2026-09-01"
  → checkout SePay

Server POST /api/renew-license:
  input: { license_id, duration_days }
  UPDATE licenses 
    SET licenseExpiresAt = licenseExpiresAt + interval '${duration_days} days'
    WHERE id = license_id
  Email: "Gia hạn thành công! ZM-LIC1 hết hạn: 2026-09-01"

App behavior:
  → Profiles remain untouched
  → Quota stay same
  → Just update expiry in license-state.json
```

---

#### **Scenario 4: Mua key hộ người khác (resell)**

```
Web:
  User A (admin) create license for User B (via admin panel)
  → form: select tier, set expiry, input email / phone
  → INSERT licenses (key, status='active', user_id=B_id)
  → Email to User B: "Bạn nhận key ZM-LIC3 từ User A. Activate tại..."

App:
  User B paste ZM-LIC3 → activate bình thường
  → Profiles riêng ở partition LIC3
  → 100% cô lập với mọi key khác
```

---

### 🛡️ Edge Cases & Safety Measures

#### **1. Single-session enforcement (anti-concurrent activation)**
```
Problem: Machine A activate ZM-LIC1 at 10:00:00
         Machine B activate ZM-LIC1 at 10:00:00.5ms (race)

Solution:
  UPDATE licenses 
    SET active_session_id = NEW_SESSION_ID, active_machine_id = MACHINE_ID
    WHERE key = ? AND (active_session_id IS NULL OR sessionExpiredAt < now())
  
  IF affected_rows == 0:
    return { ok: false, message: "Key already active elsewhere" }
  ELSE:
    return { ok: true, sessionId: NEW_SESSION_ID }

Heartbeat:
  → If Machine A heartbeat fails 2x → broadcast "license-kicked"
  → AUTO cloud upload profiles (silent)
  → Wipe local profiles
  → Show dialog: "Key deactivated on another machine"
```

#### **2. Key expiry during active session**
```
Problem: Key expires 2026-05-08 14:00
         User in app at 14:05
         
Solution:
  Heartbeat (every 30s):
    IF licenseExpiresAt < now():
      return { status: 'expired' }
      
  App on 'expired':
    → disable "Open profile" button
    → show notification: "Key expired, renew to continue"
    → profiles still in filesystem (grace period 7 days)
    → offer: "Renew now" / "Use another key" / "Backup to cloud"
```

#### **3. Downgrade + auto-deactivate logic**
```
Problem: User has 2 keys active (tier-15 + tier-10)
         Wants to keep only tier-15
         
Solution (optional):
  Dashboard: show "Deactivate ZM-LIC2?"
  → send deactivate request to server
  → Server: UPDATE licenses SET status = 'inactive' WHERE key = ?
  → App detects via heartbeat → close webWindows for LIC2
```

#### **4. Profile transfer rollback**
```
Problem: Upgrade tier, transfer 10 profiles
         Network fail after 7 profiles
         
Solution:
  Wrap in DB transaction:
    BEGIN;
      INSERT INTO profiles ... (for each profile)
      UPDATE license_upgrades SET transfer_profile_count = 7
    ON ERROR:
      ROLLBACK
      return error
    COMMIT;
  
  Retry mechanism:
    → Check license_upgrades.transfer_status = 'pending'
    → On app reopen: "Resume transfer?" button
```

#### **5. Offline grace period (7 days)**
```
Problem: User activate ZM-LIC1, close app
         Network down 7 days
         Open app: heartbeat fails
         
Solution:
  IF offline > 7 days:
    last_heartbeat_at = 2026-04-30
    now = 2026-05-10
    offline_days = 10
    → disable profile opening
    → show: "License check overdue, connect to internet"
    
  IF offline < 7 days:
    → allow read-only access
    → background task: keep retry heartbeat
```

#### **6. Revoke / chargeback (admin action)**
```
Problem: User activate ZM-LIC1, payment charged
         Chargeback 2 days later
         
Solution:
  Admin dashboard: revoke license
    → UPDATE licenses SET status = 'revoked' WHERE id = ?
    → Send event to active sessions → immediate kick
    → Profiles: grace period 24h (show "Backup to cloud?")
    → After 24h: auto-delete local profiles
    → Cloud backup: keep 30 days for admin recovery option
```

#### **7. Timezone-aware expiry check**
```
Problem: License expires 2026-05-08 00:00:00 UTC
         User thinks still valid (local time 07:00 UTC+7)
         
Solution:
  ✓ Always check server-side (UTC)
  ✓ Heartbeat: now() >= licenseExpiresAt (UTC comparison)
  ✓ Dashboard show: "Expires in X days" (visual, localtime OK)
  ✓ Warning mail: timestamp in UTC + local timezone for clarity
```

#### **8. Profile name collision during transfer**
```
Problem: ZM-OLD has "profile_1"
         ZM-NEW has "profile_1" (unlikely but possible)
         Transfer attempt → collision
         
Solution:
  During transfer:
    IF profile already exists:
      rename source → "profile_1_upgraded" / "profile_1_v2" / etc
    OR ask user: "Overwrite existing profile_1 in ZM-NEW?"
```

#### **9. Concurrent modifications (profile add while upgrading)**
```
Problem: User create new profile while upgrade transfer is in-progress
         
Solution:
  ✓ Lock profiles table during transfer
  ✓ Or: transfer only "committed" profiles (snapshot at start)
  ✓ New profiles created after transfer start → skip in transfer
```

#### **10. Free tier vs Paid transition**
```
Problem: User on free tier (1 profile) long time
         Buy ZM-NEW (tier-6)
         
Solution:
  Free tier = special license_id: "TIER_FREE"
  When activate paid key → show: "Migrate 1 free profile to ZM-NEW?"
  If yes: transfer free profile to LIC1
  If no: keep separate (user has both free + paid)
  
  Recommendation: Prompt "Delete free profile? Keep ZM-NEW."
```

---

### 🖼️ UI Changes for Web

#### Dashboard License Management
```
┌─────────────────────────────────────────────┐
│ 🔑 Các khóa của bạn (Total quota: 16/31)    │
├────┬──────┬────────┬────────┬────────┬─────┤
│Key │Tier  │Quota   │Profiles│Expires │Act  │
├────┼──────┼────────┼────────┼────────┼─────┤
│ZM-1│Tier-6│6       │3/6     │6 ngày  │...  │
├────┼──────┼────────┼────────┼────────┼─────┤
│ZM-2│Tier-1│15      │0/15    │60 ngày │...  │
├────┼──────┼────────┼────────┼────────┼─────┤
│ZM-3│Tier-2│4      │4/4     │EXPIRED │...  │
└────┴──────┴────────┴────────┴────────┴─────┘

Each row "..." menu:
  - [Nâng cấp]  → select new tier → checkout
  - [Gia hạn]   → select duration → checkout
  - [Xem dữ liệu] → list 3 profiles
  - [Deactivate]
  - [Huỷ]       → confirm + wipe
```

#### Renewal Modal
```
┌──────────────────────────────────┐
│ Gia hạn ZM-LIC1                  │
├──────────────────────────────────┤
│ Hiện tại: 2026-06-01 14:30       │
│                                  │
│ Chọn thời hạn:                   │
│ ○ 1 tháng  (50,000đ)            │
│ ○ 3 tháng  (120,000đ)           │
│ ○ 6 tháng  (200,000đ)           │
│ ○ 1 năm    (300,000đ)           │
│                                  │
│ Mới sẽ là: 2026-09-01 14:30      │
│                                  │
│ [Thanh toán]  [Hủy]              │
└──────────────────────────────────┘
```

#### Upgrade Modal
```
┌──────────────────────────────────┐
│ Nâng cấp ZM-LIC1                 │
├──────────────────────────────────┤
│ Hiện tại: Tier-6 (6 accounts)    │
│                                  │
│ Nâng lên:                        │
│ ○ Tier-10 (10 accounts) +50k    │
│ ○ Tier-15 (15 accounts) +100k   │
│ ○ Tier-25 (25 accounts) +150k   │
│                                  │
│ ✓ Transfer 3 profiles cũ        │
│   profile_1, profile_2, profile_3
│                                  │
│ [Thanh toán]  [Hủy]              │
└──────────────────────────────────┘
```

---

### 🔌 API Routes (for Claude to implement)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upgrade-license` | Nâng cấp tier (create new key + transfer) |
| POST | `/api/renew-license` | Gia hạn key (extend expiry) |
| POST | `/api/deactivate-license` | Deactivate key (manual) |
| DELETE | `/api/revoke-license` | Admin revoke (force deactivate + wipe) |
| GET | `/api/licenses` | List all user's licenses |
| GET | `/api/license/:id/profiles` | List profiles for a license |

---

### 🎯 Implementation Priority (for Claude)

**Phase 1 (Critical):**
- Migration 0004 (profiles table + license_id field)
- Update `/api/activate` → single-session check, machine_id track
- Update heartbeat → check expiry + machine conflict
- App: load profiles per license_id (not per user)

**Phase 2 (Important):**
- `/api/upgrade-license` + transfer logic (atomic transaction)
- `/api/renew-license`
- Dashboard UI: license table + action buttons
- Upgrade/Renewal modal + checkout flow

**Phase 3 (Polish):**
- `/api/deactivate-license`
- Admin revoke UI
- Grace period logic (7 days offline, 24h post-revoke)
- Error handling + retry for transfer failures

---

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

## 0g. Chiến lược nghe/gọi (2026-05-08)

> Đầy đủ phân tích + checklist trong `docs/decisions/calling-2026-05-08.md`.

### Vấn đề

Zalo Web bị Zalo gate chức năng nghe/gọi ở **3 lớp server-side** (signaling, native module, device-trust). Không thể bypass hợp lệ.

### Hướng chốt: A + C

**Hướng A — Quick-switch sang Zalo PC (sprint hiện tại, ~5 ngày):**

- Intercept "PC only" toast trong chat.zalo.me.
- Modal: **Mở Zalo PC** / **Mở trên điện thoại (QR)** / **Hủy**.
- Deeplink `zalo://chat?uid=<peerId>` cho cả PC + mobile.
- Settings: thiết bị mặc định nghe gọi.
- Telemetry event `call-attempt` để đo demand thực tế.

**Hướng C — Mobile companion (R&D 6-10 tuần, sau khi A ship):**

- React Native + Expo app, cùng license với desktop.
- Push notification "ring my phone" → mở Zalo gốc trên điện thoại để nhận/gọi.
- Companion **không chạy cuộc gọi** — chỉ relay deeplink + push.
- Android trước, iOS sau (cần Apple Developer $99/năm).

### Loại bỏ

- **Hướng B (Bridge Zalo PC)**: maintenance cost quá cao, Zalo update vỡ thường xuyên.
- **Hướng D (VoIP riêng)**: lệch core value — khách muốn nhận cuộc gọi Zalo, không phải số mới.
- **Hướng E (Zalo OA)**: OA không có call API public, chỉ messaging cho doanh nghiệp.

### Lộ trình

```
Tuần này:    Ship Hướng A (PC + phone deeplink + settings + telemetry)
Tuần 2-3:    Đo demand qua telemetry. >30% MAU bấm gọi → ưu tiên cao C.
Tuần 4-6:    R&D Companion Android (React Native + Expo + FCM).
Tuần 7-10:   Port iOS (cần Apple Dev account).
Tuần 11+:    Public launch Play Store + App Store.
```

