param(
  [Parameter(Mandatory = $true)][string]$RawProxy
)

$ErrorActionPreference = 'Continue'

function Parse-RawProxy {
  param([string]$InputValue)

  $raw = ([string]$InputValue).Trim()
  if (-not $raw) { throw 'Raw proxy is empty' }

  $protocol = ''
  $body = $raw
  if ($raw -match '^(?<p>[a-zA-Z0-9]+)://(?<rest>.+)$') {
    $protocol = $matches['p'].ToUpperInvariant()
    $body = $matches['rest']
  }

  $user = ''
  $pass = ''
  $proxyHost = ''
  $proxyPort = 0

  if ($body -match '^(?<auth>[^@]+)@(?<hp>.+)$') {
    $auth = $matches['auth']
    $hp = $matches['hp']
    if ($auth -match '^(?<u>[^:]+):(?<pw>.+)$') {
      $user = $matches['u']
      $pass = $matches['pw']
    }
    if ($hp -match '^(?<h>[^:]+):(?<pt>\d+)$') {
      $proxyHost = $matches['h']
      $proxyPort = [int]$matches['pt']
    }
  } elseif ($body -match '^(?<h>[^:]+):(?<pt>\d+):(?<u>[^:]+):(?<pw>.+)$') {
    $proxyHost = $matches['h']
    $proxyPort = [int]$matches['pt']
    $user = $matches['u']
    $pass = $matches['pw']
  } elseif ($body -match '^(?<h>[^:]+):(?<pt>\d+)$') {
    $proxyHost = $matches['h']
    $proxyPort = [int]$matches['pt']
  }

  if (-not $proxyHost -or $proxyPort -le 0) {
    throw "Cannot parse proxy string: $InputValue"
  }

  [pscustomobject]@{
    Protocol = $protocol
    Host = $proxyHost
    Port = $proxyPort
    Username = $user
    Password = $pass
  }
}

function Test-WithCurl {
  param(
    [string]$Label,
    [string]$ProxyUrl,
    [string]$Username,
    [string]$Password
  )

  $target = 'https://api.ipify.org?format=json'
  $args = @('-sS', '--max-time', '12', '--connect-timeout', '8', '--proxy', $ProxyUrl)
  if ($Username) {
    $args += @('--proxy-user', "$Username`:$Password")
  }
  $args += $target

  $output = & curl.exe @args 2>&1
  $exitCode = $LASTEXITCODE

  $ok = $false
  $ip = ''
  $message = ''

  if ($exitCode -eq 0) {
    try {
      $json = $output | ConvertFrom-Json
      if ($json.ip) {
        $ok = $true
        $ip = [string]$json.ip
      } else {
        $message = 'No ip field in JSON response'
      }
    } catch {
      $message = 'Response is not valid JSON'
    }
  } else {
    $message = ($output | Out-String).Trim()
  }

  [pscustomobject]@{
    mode = $Label
    proxy = $ProxyUrl
    ok = $ok
    ip = $ip
    exitCode = $exitCode
    message = $message
  }
}

$proxy = Parse-RawProxy -InputValue $RawProxy

$schemes = @('http', 'https', 'socks5h')
if ($proxy.Protocol -eq 'SOCKS5') { $schemes = @('socks5h', 'http', 'https') }
if ($proxy.Protocol -eq 'HTTPS') { $schemes = @('https', 'http', 'socks5h') }
if ($proxy.Protocol -eq 'HTTP') { $schemes = @('http', 'https', 'socks5h') }

$results = @()
foreach ($scheme in $schemes) {
  $proxyUrl = "${scheme}://$($proxy.Host):$($proxy.Port)"
  $results += Test-WithCurl -Label $scheme -ProxyUrl $proxyUrl -Username $proxy.Username -Password $proxy.Password
}

$results | ConvertTo-Json -Depth 4
