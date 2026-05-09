# ZaloMask

> Multi-account Zalo PC cho Windows. Mỗi profile chạy bản Zalo PC bundled
> trong installer (không cần user cài Zalo riêng), có cây `AppData/Roaming/ZaloData`
> độc lập. Backend bán license + đồng bộ session ở [zalomask.com](https://zalomask.com).

## Repo layout

| Thư mục | Vai trò |
|---|---|
| `app/` | Ứng dụng Electron (entry `main.v2.js`). |
| `app/clone/` | PC mode runtime — `clone-runtime.js` quản lý launch / terminate / proxy bridge cho từng profile. |
| `app/zalo-runtime/` | Bản Zalo PC bundled (gitignored). Chuẩn bị local trước khi build, xem `app/zalo-runtime/README.md`. |
| `web/` | Next.js 14 — landing, pricing, dashboard, admin, API. Deploy độc lập sang Vercel. Xem [web/README.md](web/README.md). |
| `.github/workflows/release.yml` | CI build NSIS installer + push GitHub Release khi tag `v*`. |
| `KE_HOACH.md` | Lộ trình sản phẩm 5 phase. |
| `AGENTS.md` | Tài liệu kỹ thuật cho AI assistants làm việc trên repo. |
| `docs/` | Handbook + decisions + archive (xem `docs/README.md`). |

## Cài đặt + chạy app

```powershell
cd C:\Users\Admin\Documents\PCZaloClone\app
npm install
.\node_modules\.bin\electron.cmd .
```

Không cần quyền Admin. Lần đầu chạy:
- Tab "Nhân bản Zalo" → "Thêm Zalo" → đặt tên + (tuỳ chọn) proxy.
- Zalo PC mở ra → quét QR đăng nhập như bình thường.
- Cookies + localStorage tự lưu vào `profiles/<name>/meta.json`.

## Auto-update

App tự kiểm tra GitHub Releases mỗi giờ. Khi có bản mới, badge "⬆ Bản mới"
xuất hiện ở titlebar; bấm vào → modal hiển thị changelog → tải + cài.

Để release bản mới:

```bash
# Bump version
cd app
npm version patch        # 26.3.1 → 26.3.2

# Push commit + tag
git push origin main --tags
```

CI workflow `.github/workflows/release.yml` build NSIS installer + tạo GitHub
Release tự động. **Yêu cầu trước khi push:** replace `REPLACE_GITHUB_OWNER` /
`REPLACE_GITHUB_REPO` ở `app/package.json` (build.publish) và `config.json`.

> Chưa code-sign (Phase 4 mới mua EV cert ~$330/năm). Người dùng sẽ thấy
> SmartScreen warning lần đầu — đây là dự kiến.

## License flow

App chạy **gói miễn phí 1 Zalo** ngay không cần đăng nhập.

Mua key trên `zalomask.com` → nhận key qua email → mở app → tab "Cài đặt" →
"License" → dán key → bấm "Kích hoạt". App gọi `POST /api/activate`, server
trả Ed25519-signed token. Heartbeat 30s/lần qua `POST /api/heartbeat`. Một
key chỉ active được trên 1 máy tại một thời điểm — kích hoạt máy mới sẽ
tự kick máy cũ.

## Gioi han quan trong: nghe/goi

- Runtime hien tai cua app su dung Zalo Web (`chat.zalo.me`).
- Tinh nang nghe/goi video/audio duoc Zalo mo ta la chi danh cho Zalo PC,
	nen ban web se khong goi duoc day du.
- Vi vay, huong su dung de xuyen suot la:
	1. Dung ZaloMask de quan ly chat da tai khoan.
	2. Khi can goi, mo Zalo PC chinh chu de thuc hien cuoc goi.

Ghi chu: day la gioi han tu phia nen tang Zalo, khong phai loi giao dien cua app.

## Vấn đề & support

- SĐT / Zalo: 0981897779
- Telegram: @zalomask

## Phát triển tiếp

Xem [KE_HOACH.md](KE_HOACH.md) để biết lộ trình + việc kế tiếp.

## Tài liệu kỹ thuật

- `docs/HANDBOOK.md`: tổng hợp luồng quan trọng + vị trí file
- `docs/decisions/calling-2026-05-08.md`: quyết định nghe/gọi

## FAQ

### Vì sao bấm nút gọi trong app báo "tính năng chỉ dành cho Zalo PC"?

Đây là giới hạn từ phía Zalo, không phải lỗi của ZaloMask. Zalo chặn nghe/gọi qua web client ở 3 lớp server-side (signaling, native module, device-trust) — không có cách hợp lệ nào bật lại.

ZaloMask giải quyết bằng **Quick-switch sang Zalo PC**:

- Bấm nút gọi trong chat → modal hiện ra với 2 lựa chọn:
  - **Mở Zalo PC** — ZaloMask tự launch Zalo PC chính chủ + mở đúng cuộc trò chuyện. Yêu cầu cài Zalo PC trước (https://zalo.me/pc).
  - **Mở trên điện thoại** — ZaloMask hiện QR; quét bằng điện thoại đã cài Zalo, mở thẳng cuộc trò chuyện để gọi.
- Trong Cài đặt có option "Thiết bị nghe gọi mặc định" để bypass modal.

Đầy đủ chi tiết trong `docs/decisions/calling-2026-05-08.md`.

### App có app mobile không?

Đang R&D. Mobile companion (Android + iOS) sẽ làm sau khi Hướng A (PC quick-switch) chạy ổn định và có dữ liệu demand thực tế. Dự kiến 4-6 tuần Android, 3-4 tuần iOS sau đó.

### Vì sao không gọi luôn trong web bằng WebRTC tự build?

Đã thử + verify: Zalo server không chấp nhận signaling từ client type `web`, dù JS có tự gọi WebRTC API thì cuộc gọi không kết nối được tới đối phương. Bypass = vi phạm ToS Zalo + dễ bị ban tài khoản.
