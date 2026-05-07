param(
  [string]$BaseUrl = "http://localhost:3000",
  [string]$SeedSecret = $env:DEV_SEED_SECRET,
  [string]$UserEmail = "",
  [string]$TierId = "tier-6",
  [string]$Duration = "1m",
  [switch]$SimulateKick
)

$ErrorActionPreference = "Stop"

function Invoke-JsonApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [hashtable]$Headers,
    [string]$Body
  )

  try {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ContentType "application/json" -Body $Body
  } catch {
    $resp = $_.Exception.Response
    $statusCode = ""
    $respBody = ""

    if ($resp) {
      try { $statusCode = [int]$resp.StatusCode } catch {}
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $respBody = $reader.ReadToEnd()
      } catch {}
    }

    if ($respBody) {
      throw "HTTP $statusCode from ${Uri}: $respBody"
    }
    throw "Request failed for ${Uri}: $($_.Exception.Message)"
  }
}

if ([string]::IsNullOrWhiteSpace($SeedSecret)) {
  Write-Error "Missing DEV_SEED_SECRET. Set env DEV_SEED_SECRET or pass -SeedSecret."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($UserEmail)) {
  Write-Error "Missing -UserEmail. Example: npm run smoke:license -- -UserEmail you@example.com"
  exit 1
}

$headers = @{ "x-dev-seed-secret" = $SeedSecret }
$seedBody = @{ email = $UserEmail; tierId = $TierId; duration = $Duration } | ConvertTo-Json
Write-Host "[1/4] Seeding test license..."
$seed = Invoke-JsonApi -Method Post -Uri "$BaseUrl/api/dev/seed-license" -Headers $headers -Body $seedBody

if (-not $seed.ok) {
  Write-Error "Seed failed: $($seed.message)"
  exit 1
}

$key = [string]$seed.license.key
$fp = "dev-" + [Guid]::NewGuid().ToString("N")
$deviceName = "PC-DEV"

Write-Host "[2/4] Activating key $key ..."
$activateBody = @{ key = $key; deviceFingerprint = $fp; deviceName = $deviceName; appVersion = "dev-smoke" } | ConvertTo-Json
$activate = Invoke-JsonApi -Method Post -Uri "$BaseUrl/api/activate" -Body $activateBody

if (-not $activate.ok) {
  Write-Error "Activate failed: $($activate.message)"
  exit 1
}

$sessionId = [string]$activate.sessionId
Write-Host "[3/4] Heartbeat session $sessionId ..."
$hbBody = @{ sessionId = $sessionId } | ConvertTo-Json
$hb = Invoke-JsonApi -Method Post -Uri "$BaseUrl/api/heartbeat" -Body $hbBody

$status = [string]$hb.status
if ($status -ne "ok") {
  Write-Error "Heartbeat failed: $status"
  exit 1
}

Write-Host "[4/4] Smoke success"
Write-Host "  key       : $key"
Write-Host "  sessionId : $sessionId"
Write-Host "  quota     : $($activate.accountQuota)"
Write-Host "  expiresAt : $($activate.licenseExpiresAt)"

if ($SimulateKick) {
  Write-Host "[Kick test] Activate same key on another fingerprint..."
  $activate2Body = @{ key = $key; deviceFingerprint = ("dev-" + [Guid]::NewGuid().ToString("N")); deviceName = "PC-DEV-2"; appVersion = "dev-smoke" } | ConvertTo-Json
  $activate2 = Invoke-JsonApi -Method Post -Uri "$BaseUrl/api/activate" -Body $activate2Body
  $hbOld = Invoke-JsonApi -Method Post -Uri "$BaseUrl/api/heartbeat" -Body $hbBody

  Write-Host "  new session : $($activate2.sessionId)"
  Write-Host "  old heartbeat status: $($hbOld.status)"
}
