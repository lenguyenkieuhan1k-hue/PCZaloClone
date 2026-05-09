# Thám tử Export/Import - Hướng dẫn Step-by-Step

## Mục tiêu
Capture & phân tích behavior của ZaX (đối thủ) khi export/import, sau đó so sánh với ZaloMask để tìm bug.

---

## Bước 1: Monitor ZaX Activity (5 phút)

### Lệnh
```powershell
cd C:\Users\Admin\Documents\PCZaloClone
.\monitor-zax.ps1
```

### Trong terminal mà monitor chạy:
Sau khi monitor thông báo "Watching for changes..."

1. **Mở ZaX app**
   - `C:\Users\Admin\AppData\Local\Programs\ZaX\ZaX.exe` hoặc từ Start menu
2. **Export account**
3. **Import account**

> File này là ghi chú debug theo phiên (archive).

