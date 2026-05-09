#Requires -Version 5.1
<#
.SYNOPSIS
  Copy bundled Zalo PC runtime vào app/zalo-runtime/ để ZaloMask bundle vào installer.

.DESCRIPTION
  Chạy một lần bởi developer trước khi build.
  Yêu cầu Zalo PC đã cài trên máy (nếu chưa có sẽ tự tải installer và cài).
  Sau khi xong, build với:  cd app && npx electron-builder --win nsis --x64 --publish never
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$destDir  = Join-Path $repoRoot 'app\zalo-runtime'
$zaloSrc  = Join-Path $env:LOCALAPPDATA 'Programs\Zalo'

Write-Host ""
Write-Host "=== ZaloMask — setup-zalo-runtime ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Kiểm tra Zalo đã cài chưa ───────────────────────────────────
$zaloExeSrc = Join-Path $zaloSrc 'Zalo.exe'

if (-not (Test-Path $zaloExeSrc)) {
    Write-Host "Zalo PC chua cai. Dang tai ZaloSetup.exe..." -ForegroundColor Yellow

    $installer = Join-Path $env:TEMP 'ZaloSetup.exe'
    $zaloUrl = 'https://res-download.zaloapp.com/pc/zalo/ZaloSetup.exe'

    Write-Host "  URL: $zaloUrl"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $zaloUrl -OutFile $installer -UseBasicParsing -TimeoutSec 180
    $ProgressPreference = 'Continue'
    Write-Host "  Tai xong. Cai silent..." -ForegroundColor Green

    Start-Process -FilePath $installer -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 8

    if (-not (Test-Path $zaloExeSrc)) {
        Write-Host "ERROR: Cai xong nhung khong tim thay $zaloExeSrc" -ForegroundColor Red
        Write-Host "Hay cai Zalo thu cong tu https://zalo.me/pc roi chay lai." -ForegroundColor Yellow
        exit 1
    }

    Write-Host "  Zalo da cai tai: $zaloSrc" -ForegroundColor Green
}

Write-Host "Nguon: $zaloSrc"

# ── 2. Xóa dest cũ ─────────────────────────────────────────────────
if (Test-Path $destDir) {
    Write-Host "Xoa zalo-runtime/ cu..."
    Remove-Item $destDir -Recurse -Force
}
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

# ── 3. Copy ────────────────────────────────────────────────────────
Write-Host "Copy $zaloSrc => $destDir ..."
$items = Get-ChildItem $zaloSrc
$total = $items.Count
$i = 0

foreach ($item in $items) {
    $i++
    $pct = [int](($i / $total) * 100)
    Write-Progress -Activity "Copy Zalo runtime" -Status $item.Name -PercentComplete $pct
    $dst = Join-Path $destDir $item.Name
    if ($item.PSIsContainer) {
        Copy-Item $item.FullName $dst -Recurse -Force
    } else {
        Copy-Item $item.FullName $dst -Force
    }
}
Write-Progress -Activity "Copy Zalo runtime" -Completed

# ── 3b. Xóa bản backup / artifact patch (tránh installer ~1GB+ thừa) ──
Write-Host "Don rac backup app.asar + artifact patch (neu co)..."
$suffixRx = '^app\.asar\.(backup|directbak|hotfixbak|testbak2?)$'
Get-ChildItem -LiteralPath $destDir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match $suffixRx -or $_.Name -eq 'app-repacked.asar') {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}
Get-ChildItem -LiteralPath $destDir -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq '.asar-extract' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Get-ChildItem -LiteralPath $destDir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq '.asar-patch-done.txt' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

# ── 4. Xác nhận ────────────────────────────────────────────────────
$zaloExeDst = Join-Path $destDir 'Zalo.exe'
if (-not (Test-Path $zaloExeDst)) {
    Write-Host "ERROR: Zalo.exe khong co trong $destDir" -ForegroundColor Red
    exit 1
}

$sizeMB = [math]::Round(
    (Get-ChildItem $destDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1
)

Write-Host ""
Write-Host "Done! Zalo runtime san sang tai app\zalo-runtime\ ($sizeMB MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Buoc tiep theo - build installer:" -ForegroundColor Cyan
Write-Host "  cd app"
Write-Host "  npx electron-builder --win nsis --x64 --publish never"
Write-Host ""
