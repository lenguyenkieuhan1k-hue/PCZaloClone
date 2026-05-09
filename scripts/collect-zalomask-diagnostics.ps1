# ZaloMask — gom log máy khách khi app không mở hoặc cần gói tối giản.
# Chạy: powershell -ExecutionPolicy Bypass -File .\scripts\collect-zalomask-diagnostics.ps1
# Hoặc: -OutZip "C:\Temp\diag.zip"

param(
  [string]$OutZip = "",
  [string]$UserData = $(Join-Path $env:APPDATA "ZaloMask")
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
if (-not $OutZip) {
  $OutZip = Join-Path ([Environment]::GetFolderPath("Desktop")) "ZaloMask-diagnostics-$stamp.zip"
}

$tmp = Join-Path $env:TEMP "zalomask-collect-$stamp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $m = [ordered]@{
    collectedAt   = (Get-Date).ToUniversalTime().ToString("o")
    userDataPath  = $UserData
    computer      = $env:COMPUTERNAME
    psVersion     = $PSVersionTable.PSVersion.ToString()
    note          = "Script-only collection; in-app export includes runtime JSON + full tail."
  }
  ($m | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $tmp "manifest-ps1.json") -Encoding UTF8

  $readme = @"
ZaloMask — gói chẩn đoán (PowerShell)

Đính kèm file ZIP khi gửi báo lỗi / chat support.
Log nằm tại: $UserData\app-runtime.log
"@
  Set-Content -Path (Join-Path $tmp "README-diagnostics.txt") -Value $readme -Encoding UTF8

  $log = Join-Path $UserData "app-runtime.log"
  if (Test-Path -LiteralPath $log) {
    Get-Content -LiteralPath $log -Tail 15000 | ForEach-Object {
      $_ -replace '"password"\s*:\s*"[^"]*"', '"password":"***"' `
         -replace '"token"\s*:\s*"[^"]{8,}"', '"token":"***"'
    } | Set-Content (Join-Path $tmp "app-runtime.tail.log") -Encoding UTF8
  }
  else {
    Set-Content (Join-Path $tmp "app-runtime.tail.log") "(missing) $log" -Encoding UTF8
  }

  $localRt = Join-Path $env:LOCALAPPDATA "ZaloMask\runtime"
  if (Test-Path -LiteralPath $localRt) {
    Get-ChildItem -LiteralPath $localRt -ErrorAction SilentlyContinue |
      Select-Object Name, LastWriteTime, Mode |
      ConvertTo-Json -Depth 3 |
      Set-Content (Join-Path $tmp "local-runtime-dir-list.json") -Encoding UTF8
  }

  if (Test-Path -LiteralPath $OutZip) { Remove-Item -LiteralPath $OutZip -Force }
  Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $OutZip -CompressionLevel Fastest -Force

  Write-Host "OK: $OutZip"
  Start-Process explorer.exe -ArgumentList "/select,`"$OutZip`""
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
