#Requires -Version 5.1
<#
.SYNOPSIS
  Copy bundled Zalo PC runtime vào app/zalo-runtime/ để ZaloMask bundle vào installer.

.DESCRIPTION
  Chạy một lần bởi developer trước khi build.
  Yêu cầu Zalo PC đã cài trên máy (nếu chưa có sẽ tự cài).
  CI (GITHUB_ACTIONS): ưu tiên winget (VNGCorp.Zalo); máy dev: ZaloSetup.exe + /S.
  Mirror CI (khuyến nghị): ZALOMASK_SUPABASE_ZALO_SETUP_URL — URL public Supabase Storage tới ZaloSetup.exe.
  Mirror khác: ZALOMASK_ZALO_SETUP_URL (bất kỳ host resolve được trên runner).
  Sau khi xong:  cd app && npx electron-builder --win nsis --x64 --publish never
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$destDir  = Join-Path $repoRoot 'app\zalo-runtime'
$zaloSrc  = Join-Path $env:LOCALAPPDATA 'Programs\Zalo'

Write-Host ""
Write-Host "=== ZaloMask — setup-zalo-runtime ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Kiểm tra / cài Zalo PC ────────────────────────────────────────
$zaloExeSrc = Join-Path $zaloSrc 'Zalo.exe'

function Wait-ForZaloExe {
    param([int]$TimeoutSec = 240)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $zaloExeSrc) { return $true }
        Start-Sleep -Seconds 3
    }
    return (Test-Path $zaloExeSrc)
}

function Download-ZaloSetupExe {
    param([string]$OutPath)

    try {
        $p = [Net.SecurityProtocolType]::Tls12
        if ([Enum]::IsDefined([Net.SecurityProtocolType], 'Tls13')) {
            $p = $p -bor [Net.SecurityProtocolType]::Tls13
        }
        [Net.ServicePointManager]::SecurityProtocol = $p
    }
    catch { }

    $urls = New-Object System.Collections.Generic.List[string]
    foreach ($key in @('ZALOMASK_SUPABASE_ZALO_SETUP_URL', 'ZALOMASK_ZALO_SETUP_URL')) {
        $v = [Environment]::GetEnvironmentVariable($key)
        if ($v -and $v.Trim().Length -gt 0) { $urls.Add($v.Trim()) }
    }
    $urls.Add('https://res-download.zaloapp.com/pc/zalo/ZaloSetup.exe')

    $headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36' }
    $ProgressPreference = 'SilentlyContinue'
    $lastMsg = ''

    foreach ($u in $urls) {
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                Write-Host "  Download ZaloSetup (try $attempt): $u" -ForegroundColor DarkGray
                Invoke-WebRequest -Uri $u -OutFile $OutPath -UseBasicParsing -TimeoutSec 300 -Headers $headers
                $len = 0
                if (Test-Path $OutPath) { $len = (Get-Item $OutPath).Length }
                if ($len -gt 2MB) {
                    Write-Host '  Tai ZaloSetup xong.' -ForegroundColor Green
                    return
                }
                Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
                $lastMsg = ('File too small: ' + $len + ' bytes')
            }
            catch {
                $lastMsg = $_.Exception.Message
                Write-Warning "  $($_.Exception.Message)"
                Start-Sleep -Seconds ([Math]::Min(6 * $attempt, 35))
            }
        }
    }
    $ProgressPreference = 'Continue'

    Write-Host "ERROR: Khong tai duoc ZaloSetup. Last: $lastMsg" -ForegroundColor Red
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host 'Goi y CI: Tao secret ZALOMASK_SUPABASE_ZALO_SETUP_URL = URL public object Supabase Storage (ZaloSetup.exe).' -ForegroundColor Yellow
        Write-Host 'Hoac secret ZALOMASK_ZALO_SETUP_URL = mirror khac CDN VNG neu DNS res-download.zaloapp.com fail.' -ForegroundColor Yellow
    }
    exit 1
}

function Get-WingetPath {
    $cmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($cmd.Source) { return $cmd.Source }
    $wug = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path $wug -PathType Leaf) { return $wug }
    return ''
}

function Install-ZaloViaWinget {
    $wingExe = Get-WingetPath
    if (-not $wingExe) {
        Write-Warning '  Khong tim thay winget; bo qua.'
        return
    }

    Write-Host '  Dang cai Zalo bang winget (VNGCorp.Zalo)...' -ForegroundColor Yellow
    $wingetArgs = @(
        'install', '--id', 'VNGCorp.Zalo', '--exact',
        '--accept-package-agreements', '--accept-source-agreements',
        '--disable-interactivity', '--silent'
    )
    try {
        $proc = Start-Process -FilePath $wingExe -ArgumentList $wingetArgs -Wait -PassThru -NoNewWindow
        Write-Host ("  winget ExitCode: " + $proc.ExitCode)
    }
    catch {
        Write-Warning ("  winget Start-Process: " + $_.Exception.Message)
    }
}

if (-not (Test-Path $zaloExeSrc)) {
    Write-Host 'Zalo PC chua cai. Dang cai tu dong...' -ForegroundColor Yellow

    if ($env:GITHUB_ACTIONS -eq 'true') {
        Install-ZaloViaWinget
        if (-not (Wait-ForZaloExe -TimeoutSec 300)) {
            Write-Warning 'winget chua tao Zalo.exe dung han; thu ZaloSetup.exe...'
        }
    }

    if (-not (Test-Path $zaloExeSrc)) {
        $installer = Join-Path $env:TEMP 'ZaloSetup.exe'
        Download-ZaloSetupExe -OutPath $installer
        Write-Host '  Chay ZaloSetup /S ...' -ForegroundColor Green
        $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru -NoNewWindow
        Write-Host ("  ZaloSetup ExitCode: " + $setup.ExitCode)
        if (-not (Wait-ForZaloExe -TimeoutSec 300)) {
            Write-Host "ERROR: Khong tim thay $zaloExeSrc sau khi cai." -ForegroundColor Red
            Write-Host 'Neu may ban co Zalo o vi tri khac, copy vao %LocalAppData%\Programs\Zalo hoac cai thu cong: https://zalo.me/pc' -ForegroundColor Yellow
            if (Test-Path $zaloSrc) {
                Write-Host 'Noi dung hien co trong Programs\Zalo:' -ForegroundColor DarkYellow
                Get-ChildItem -LiteralPath $zaloSrc -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  - $($_.Name)" }
            }
            exit 1
        }
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
$items = @(Get-ChildItem -LiteralPath $zaloSrc -Force)
$total = $items.Length
if ($total -eq 0) {
    Write-Host "ERROR: Thu muc Zalo trong (khong copy duoc)." -ForegroundColor Red
    exit 1
}
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
