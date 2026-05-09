param(
  [Parameter(Mandatory=$true)][string]$ZmbPath
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $ZmbPath)) {
  throw "Missing file: $ZmbPath"
}

$outDir = Join-Path $env:TEMP ("zm-extract-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# Expand-Archive only supports .zip extension, so copy the .zmb first.
$zipCopy = Join-Path $outDir "__src.zip"
Copy-Item -LiteralPath $ZmbPath -Destination $zipCopy -Force

Expand-Archive -LiteralPath $zipCopy -DestinationPath $outDir -Force
Remove-Item -LiteralPath $zipCopy -Force

Write-Output $outDir

