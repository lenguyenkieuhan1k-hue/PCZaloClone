# ZaloMask Shell (native, preview)

Ứng dụng **Windows WPF / C#** song song với **Electron** (`app/`). Mục tiêu:

- Đọc **cùng** thư mục `profiles/` với Electron (khi cấu hình đúng gốc dữ liệu).
- Sau này mở rộng: launcher Zalo PC, license, proxy… rồi mới thay thế client Electron khi feature parity đủ.

**Electron vẫn là bản production** cho đến khi bản native được xác nhận ổn.

## Điều kiện

- [.NET 8 SDK](https://dotnet.microsoft.com/download) (Windows).

## Gốc dữ liệu (trùng Electron)

- **Cài Electron packged:** `%AppData%\ZaloMask\profiles`
- **Dev / dùng repo:** đặt biến môi trường `ZALOMASK_REPO_ROOT` = đường dẫn thư mục gốc repo (chứa `profiles\`).

Trong app: **Cài đặt gốc dữ liệu…** chọn thư mục **cha** của `profiles` (tức cùng cấp với thư mục `profiles`), hoặc chọn trực tiếp thư mục `profiles`.

## Build & chạy

```powershell
cd native\ZaloMask.Shell
dotnet build -c Release
dotnet run -c Release
```

Hoặc mở `native\ZaloMask.Native.sln` trong Visual Studio.

## Trạng hiện tại (MVP)

- Danh sách profile (tên thư mục + `displayName` trong `meta.json` nếu có).
- Cho phép chỉ định gốc dữ liệu để trùng Electron khi test song song.
