# ZaloMask Shell (native, preview)

Ứng dụng **Windows WPF / C#** song song với **Electron** (`app/`). Mục tiêu:

- Đọc **cùng** thư mục `profiles/` với Electron (khi cấu hình đúng gốc dữ liệu).
- Sau này mở rộng: launcher Zalo PC, license, proxy… rồi mới thay thế client Electron khi feature parity đủ.

**Electron vẫn là bản production** cho đến khi bản native được xác nhận ổn.

## Điều kiện

- [.NET 8 SDK](https://dotnet.microsoft.com/download) (Windows).

## Gốc dữ liệu (trùng Electron)

Thứ tự trong `DataPaths.ResolveProfilesDirectory()`:

1. `%LocalAppData%\ZaloMask\shell-preview\profiles-path.txt` (sau khi bấm «Chọn gốc dữ liệu…»).
2. **Tự nhận repo (dev):** từ thư mục chạy `dotnet run`, đi ngược lên cha tìm `profiles/` trong đó có ít nhất một thư mục con chứa `meta.json`.
3. Biến môi trường **`ZALOMASK_REPO_ROOT`** → `{repo}\profiles`.
4. Mặc định khi đã cài Electron: **`%AppData%\ZaloMask\profiles`**.

Trong app: **Chọn gốc dữ liệu…** có thể chọn thư mục **repo** (có `profiles\` bên trong) hoặc chọn trực tiếp thư mục **`profiles`**.

### Chạy local thử

- Lần đầu nếu không có `profiles` ở `%AppData%\ZaloMask`: app **không** bật hộp thoại chặn — chỉ báo đỏ trong vùng trạng thái; **Làm mới** hoặc sau khi chỉnh đường dẫn mới báo popup khi thiếu thư mục.

## Build & chạy

```powershell
cd native\ZaloMask.Shell
dotnet build -c Release
dotnet run -c Release
```

Hoặc mở `native\ZaloMask.Native.sln` trong Visual Studio.

## Trạng hiện tại (MVP)

- Danh sách profile (tên thư mục, `displayName` / `launchMode` từ `meta.json`, fallback tên thư mục, sắp xếp A→Z).
- Chọn đường dẫn `profiles`; lần mở đầu không chặn bằng MessageBox khi đường dẫn mặc định chưa có.
