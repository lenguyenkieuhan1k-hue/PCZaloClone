# legacy/ — code đã thay thế, giữ để tham khảo

Toàn bộ file trong thư mục này thuộc kiến trúc cũ (ZaloMask v1: patch `app.asar`
của Zalo PC + chạy clone qua Windows user / junction). Kể từ ngày 2026-05-07,
ứng dụng đã pivot sang kiến trúc v2:

> **v2:** mở Zalo Web (`https://chat.zalo.me/`) trong `BrowserWindow` của
> Electron, mỗi profile dùng một `partition` Chromium riêng, kèm fingerprint
> spoof + license client gọi server `zalomask.com`.

Code v2 nằm ở:

- `app/main.v2.js` — entry point, đọc IPC + license heartbeat + open BrowserWindow.
- `app/preload.js` — context bridge cho UI quản lý.
- `app/web-preload-v2.js` — preload cho mỗi BrowserWindow Zalo Web (apply fingerprint + seed/capture localStorage).
- `app/renderer/index-v2.html` + `renderer-v2.js` + `style-v2.css` — UI quản lý profile + license.
- `app/auto-update.js` — auto-update GitHub Releases.

## File nào đang ở đây và lý do

| File | Vai trò cũ | Lý do bỏ |
|---|---|---|
| `main.js` | Main process v1 (clone PC qua app.asar) | Thay bằng `main.v2.js`, kiến trúc khác hẳn |
| `clone-main-shim.js` | Shim chèn vào bootstrap Zalo PC để route APPDATA | Không còn patch Zalo nữa |
| `clone-session-preload.js` | Pin `sh_z_uuid` trong Zalo PC clone | Web2 không dùng Zalo PC |
| `clone-runtime-collector.js` | Bridge MAIN-world cho Zalo PC | Web2 dùng `web-preload-v2.js` |
| `session-store.js` | Cloud-sync abstraction cho Zalo PC clone | Web2 lưu trực tiếp trong meta.json |
| `session-supabase-provider.js` | Stub Supabase provider | Web2 không cần (license + extension đi đường khác) |
| `asar-patcher.js` | Vá `app.asar` của Zalo PC | Không patch Zalo nữa |
| `privacy-shim.js` | Block typing/seen/delivered request trong Zalo PC | Web2 chưa có equivalent (TODO nếu cần) |
| `web-session-preload.js` | Preload cũ kiểu `web` (trước khi có web2) | Thay bằng `web-preload-v2.js` |
| `zalo-preload.js` | Preload cũ qua MAIN-world script tag | Thay bằng `web-preload-v2.js` |
| `renderer-index.html` / `-renderer.js` / `-style.css` | UI cũ tab clone Zalo PC + cloud sync | Thay bằng `index-v2.html` / `renderer-v2.js` / `style-v2.css` |

## Có an toàn xoá không?

Có. Toàn bộ thư mục này không được `main.v2.js` `require()` hay `loadFile()` vào
runtime. Nếu sau này không còn cần làm reference thì `git rm -r app/legacy/` an
toàn. Trước khi xoá hẳn nhớ kiểm tra lại `git log` xem có insight nào không.
