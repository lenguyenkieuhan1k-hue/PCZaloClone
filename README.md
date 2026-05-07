# ZaloMask

> Multi-account Zalo Web cho Windows. Mỗi tài khoản chạy trong một
> `BrowserWindow` Electron riêng với `partition` Chromium độc lập + browser
> fingerprint giả lập riêng. Không patch Zalo PC, không cần Windows user thứ
> hai. Backend bán license + đồng bộ session ở [zalomask.com](https://zalomask.com).

## Repo layout

| Thư mục | Vai trò |
|---|---|
| `app/` | Ứng dụng Electron (web2 — entry `main.v2.js`). |
| `app/legacy/` | Code v1 (clone Zalo PC qua patch app.asar). Không build, giữ tham khảo. Xem `app/legacy/README.md`. |
| `web/` | Next.js 14 — landing, pricing, dashboard, admin, API. Deploy độc lập sang Vercel. Xem [web/README.md](web/README.md). |
| `extension/` | Chrome extension AutoZalo Bridge — capture session từ chat.zalo.me, đẩy về `web/api/extension-import`. |
| `.github/workflows/release.yml` | CI build NSIS installer + push GitHub Release khi tag `v*`. |
| `KE_HOACH.md` | Lộ trình sản phẩm 5 phase. |
| `AGENTS.md` | Tài liệu kỹ thuật cho AI assistants làm việc trên repo. |

## Cài đặt + chạy app

```powershell
cd C:\Users\Admin\Documents\PCZaloClone\app
npm install
.\node_modules\.bin\electron.cmd .
```

Không cần quyền Admin (kiến trúc v2 không tạo Windows user). Lần đầu chạy:
- Tab "Nhân bản Zalo" → "Thêm Zalo" → đặt tên + (tuỳ chọn) proxy.
- Cửa sổ Zalo Web mở ra → quét QR đăng nhập như bình thường.
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

## Vấn đề & support

- SĐT / Zalo: 0981897779
- Telegram: @zalomask

## Phát triển tiếp

Xem [KE_HOACH.md](KE_HOACH.md) để biết lộ trình + việc kế tiếp.
