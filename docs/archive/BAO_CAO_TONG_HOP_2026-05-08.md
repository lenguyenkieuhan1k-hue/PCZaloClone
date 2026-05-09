# BAO CAO TONG HOP CAP NHAT (2026-05-08)

## 1. Muc tieu da hoan thanh

- On dinh flow thanh toan SePay -> webhook -> dashboard.
- Fix hien thi key da mua tren dashboard, bo trang thai paid false-positive khi mua lai.
- Chuan hoa nghiep vu nang cap / gia han / huy bo theo rule moi.
- Loai bo goi test khoi bang gia, van giu tuong thich key test cu.
- Lam migration idempotent (co `DROP POLICY IF EXISTS`) de chay lai an toan.
- Fix favicon web (khong con hien icon qua dia cau tren tab browser).
- Bo sung cloud sync upload/download trong app desktop va web API.
- On dinh app desktop: proxy quick paste, check proxy trong add modal, giam input freeze modal.
- Chan dong modal do click ra ngoai voi popup co form nhap.
- Chinh kich thuoc cua so profile theo huong gon hon (mobile-like frame).

## 2. Cac van de goc da gap va da xu ly

- Dashboard rong do query cot chua co o production.
- Payment status match nham giao dich cu khi user checkout lai.
- API upgrade/renew bi Unauthorized do auth context chua dung.
- Upgrade/renew/deactivate thieu guard business rule.
- Add modal proxy parse sai chuoi `host:port:user:pass`.
- Add modal thinh thoang bi giat focus, co cam giac khong go duoc.

## 3. Thay doi ky thuat chinh

### 3.1 Web payment + dashboard

- Payment watcher match theo phien checkout (`startedAt`) + window `created_at`.
- UI thanh toan thanh cong doi sang overlay ro rang hon.
- Dashboard query da bo phu thuoc cot migration chua dong bo.

### 3.2 License rules

- Upgrade: chi len tier cao hon, hoac cung tier nhung thoi han dai hon.
- Renew: chi cho key da het han.
- Deactivate: chi thao tac voi key phu hop trang thai, phan hoi thong diep ro rang.

### 3.3 Desktop app stability

- Proxy parser nhan dung `host:port:user:pass` va `user:pass@host:port`.
- Bo loop focus interval gay cuop focus khi dang nhap trong modal.
- Backdrop click cua add/proxy modal khong con tu dong dong popup.
- Check proxy qua curl toi uu timeout + cache ket qua thanh cong ngan han.

### 3.4 Cloud sync

- Co route upload/download du lieu profiles.
- App co tab cloud voi hanh dong tai len / dong bo ve / lam moi.
- Luong kicked: auto upload backup truoc khi dong cac cua so web profile.

## 4. Trang thai release

- Da build thanh cong installer cac ban gan day (26.3.7, 26.3.8).
- Da day tag release len GitHub de trigger workflow.
- Ban hotfix input-freeze hien tai: `v26.3.8`.

## 5. Van de chinh con ton tai

### 5.1 Nhu cau nguoi dung: nghe/goi tren Zalo

- Thuc te da xac minh bang UI Zalo: tinh nang goi bi khoa tren ban web, chi cho Zalo PC.
- Day la gioi han tu phia nen tang Zalo, khong phai loi ky thuat rieng cua app.
- Do do, huong hien tai (Electron + chat.zalo.me) khong the bat nghe/goi day du nhu Zalo PC chinh chu.

## 6. Huong giai quyet de xuat

### Huong A (khuyen nghi de san pham song duoc ngay)

- Dinh vi ZaloMask la "multi-account chat runtime".
- Khi can goi, chuyen nhanh sang Zalo PC chinh chu (nut hanh dong ro rang trong UI).
- Truyen thong ro gioi han "Web khong ho tro goi" tren landing + app.

### Huong B (ky thuat trung han, rui ro cao)

- Nghien cuu mo hinh bridge voi Zalo PC desktop thay vi web.
- Muc tieu: van tach profile, nhung tan dung call stack cua desktop app.
- Rui ro: maintain kho, phu thuoc update cua Zalo PC, rui ro compatibility.

### Huong C (san pham cap cao, dai han)

- Phat trien app mobile companion (Android/iOS) + dong bo voi web/pc.
- Goi dien thuc hien tren mobile chinh chu; desktop giu vai tro quan ly da tai khoan + workflow.

## 7. Ke hoach hanh dong tiep theo (uu tien)

1. Chot messaging san pham: "chat da tai khoan" la core value.
2. Them CTA "Mo Zalo PC de goi" ngay tren danh sach profile.
3. Them note gioi han nghe/goi vao README + landing + modal huong dan.
4. Neu quyet tam theo huong B, tach spike ky thuat 1-2 tuan de danh gia kha thi.

## 8. File can theo doi chat trong dot tiep theo

- `app/main.v2.js`
- `app/renderer/renderer-v2.js`
- `app/renderer/index-v2.html`
- `app/renderer/style-v2.css`
- `web/app/checkout/[plan]/PaymentWatcher.tsx`
- `web/app/api/payment-status/route.ts`
- `web/app/dashboard/LicenseTable.tsx`
- `KE_HOACH.md`

## 9. Tong ket ngan

- Da hoan thien phan lon cac loi web payment/dashboard va do on dinh desktop app.
- Nut that san pham hien tai la nghe/goi: web bi khoa boi Zalo.
- Huong kha thi nhat de tang truong ngay: giu chat multi-account tren web, ket hop duong dan chuyen sang Zalo PC cho call.

## 10. Cap nhat: Chien luoc nghe/goi (2026-05-08, sau audit)

Da chot huong giai quyet trong tai lieu rieng:

- **`docs/decisions/calling-2026-05-08.md`** — quyet dinh ky thuat day du.

