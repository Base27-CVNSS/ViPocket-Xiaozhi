[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root '.vipocket'
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'vipocket-dev.log'
$PidFile = Join-Path $StateDir 'dev.pid'
$InstallMarker = Join-Path $StateDir 'install.sha256'
$WebUrl = 'http://127.0.0.1:5173'
$GatewayHealthUrl = 'http://127.0.0.1:8787/health'

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
Set-Location $Root

function Write-Step {
  param([string]$Text)
  Write-Host ''
  Write-Host ('[ViPocket] ' + $Text) -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Text)
  Write-Host ('[OK] ' + $Text) -ForegroundColor Green
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $extra = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
  ) -join ';'
  $env:Path = "$machinePath;$userPath;$extra"
}

function Get-NodeVersion {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try {
    $raw = (& $node.Source -p 'process.versions.node').Trim()
    return [Version]$raw
  } catch {
    return $null
  }
}

function Install-Or-Upgrade-Node {
  param([bool]$AlreadyInstalled)

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Khong tim thay Node.js va may khong co winget. Hay cai Node.js LTS 20+ roi chay lai START-VIPOCKET.cmd.'
  }

  $action = if ($AlreadyInstalled) { 'upgrade' } else { 'install' }
  Write-Step "Dang tu dong $action Node.js LTS bang winget..."
  $arguments = @(
    $action,
    '--id', 'OpenJS.NodeJS.LTS',
    '-e',
    '--source', 'winget',
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--silent',
    '--disable-interactivity'
  )

  $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  Refresh-ProcessPath

  if ($process.ExitCode -ne 0 -and -not (Get-NodeVersion)) {
    throw "winget khong the cai Node.js. Ma loi: $($process.ExitCode)."
  }
}

function Ensure-Node {
  Refresh-ProcessPath
  $version = Get-NodeVersion
  $minimum = [Version]'20.11.0'

  if (-not $version -or $version -lt $minimum) {
    Install-Or-Upgrade-Node -AlreadyInstalled ([bool]$version)
    $version = Get-NodeVersion
  }

  if (-not $version -or $version -lt $minimum) {
    throw "Can Node.js >= $minimum. Phien ban hien tai: $version"
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    throw 'Da co Node.js nhung khong tim thay npm.cmd. Hay khoi dong lai Windows va chay lai.'
  }

  Write-Ok "Node.js $version va npm da san sang."
  return $npm.Source
}

function Get-ProjectFingerprint {
  $files = @(
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'apps\web\package.json'),
    (Join-Path $Root 'apps\gateway\package.json')
  )

  $builder = New-Object System.Text.StringBuilder
  foreach ($file in $files) {
    if (-not (Test-Path $file)) {
      throw "Thieu tep bat buoc: $file"
    }
    [void]$builder.Append((Get-Content -LiteralPath $file -Raw))
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Ensure-Dependencies {
  param([string]$NpmPath)

  $fingerprint = Get-ProjectFingerprint
  $installedFingerprint = if (Test-Path $InstallMarker) { (Get-Content $InstallMarker -Raw).Trim() } else { '' }
  $nodeModules = Join-Path $Root 'node_modules'

  if ($Repair -and (Test-Path $nodeModules)) {
    Write-Step 'Che do sua loi: dang xoa node_modules cu...'
    Remove-Item -LiteralPath $nodeModules -Recurse -Force
  }

  if (-not (Test-Path $nodeModules) -or $installedFingerprint -ne $fingerprint) {
    Write-Step 'Dang cai dependency lan dau. Buoc nay co the mat 1-5 phut...'
    & $NpmPath install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "npm install that bai voi ma loi $LASTEXITCODE."
    }
    Set-Content -LiteralPath $InstallMarker -Value $fingerprint -Encoding ASCII
    Write-Ok 'Dependency da duoc cai dat.'
  } else {
    Write-Ok 'Dependency da san sang, bo qua npm install.'
  }
}

function Ensure-EnvironmentFile {
  $envFile = Join-Path $Root '.env'
  $exampleFile = Join-Path $Root '.env.example'
  if (-not (Test-Path $envFile)) {
    Copy-Item -LiteralPath $exampleFile -Destination $envFile
    Write-Ok 'Da tao .env tu .env.example.'
  }
}

function Test-Url {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Stop-TrackedProcess {
  if (-not (Test-Path $PidFile)) { return }
  $savedPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    $existing = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Step 'Dang dung tien trinh ViPocket cu de khoi dong lai sach se...'
      & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-Services {
  param([string]$NpmPath)

  $webReady = Test-Url $WebUrl
  $gatewayReady = Test-Url $GatewayHealthUrl
  if ($webReady -and $gatewayReady) {
    Write-Ok 'Web va gateway da dang chay.'
    return
  }

  if ($webReady -xor $gatewayReady) {
    Stop-TrackedProcess
    $webReady = Test-Url $WebUrl
    $gatewayReady = Test-Url $GatewayHealthUrl
    if ($webReady -xor $gatewayReady) {
      throw 'Chi mot trong hai cong 5173/8787 dang bi chiem. Hay dong ung dung cu hoac chay STOP-VIPOCKET.cmd.'
    }
  }

  Write-Step 'Dang khoi dong gateway va giao dien...'
  Set-Content -LiteralPath $LogFile -Value "ViPocket startup: $(Get-Date -Format o)" -Encoding UTF8

  $command = '"{0}" run dev 1>>"{1}" 2>&1' -f $NpmPath, $LogFile
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $command) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(150)
  do {
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
      $tail = if (Test-Path $LogFile) { (Get-Content -LiteralPath $LogFile -Tail 35) -join [Environment]::NewLine } else { 'Khong co log.' }
      throw "Tien trinh dev da dung som.`n`n$tail"
    }
    $webReady = Test-Url $WebUrl
    $gatewayReady = Test-Url $GatewayHealthUrl
  } until (($webReady -and $gatewayReady) -or (Get-Date) -ge $deadline)

  if (-not ($webReady -and $gatewayReady)) {
    $tail = if (Test-Path $LogFile) { (Get-Content -LiteralPath $LogFile -Tail 35) -join [Environment]::NewLine } else { 'Khong co log.' }
    throw "Qua thoi gian cho. Web hoac gateway chua san sang.`n`n$tail"
  }

  Write-Ok 'Gateway: http://127.0.0.1:8787/health'
  Write-Ok 'Giao dien: http://127.0.0.1:5173'
}

try {
  Write-Host '============================================================' -ForegroundColor DarkCyan
  Write-Host ' ViPocket-Xiaozhi - ONE CLICK WINDOWS LAUNCHER' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor DarkCyan

  $npmPath = Ensure-Node
  Ensure-Dependencies -NpmPath $npmPath
  Ensure-EnvironmentFile
  Start-Services -NpmPath $npmPath

  if (-not $NoBrowser) {
    Write-Step 'Dang mo ViPocket trong trinh duyet...'
    Start-Process $WebUrl
  }

  Write-Host ''
  Write-Host 'ViPocket da san sang. Co the dong cua so nay.' -ForegroundColor Green
  Write-Host 'De dung he thong, nhap dup STOP-VIPOCKET.cmd.' -ForegroundColor Gray
  Start-Sleep -Seconds 4
  exit 0
} catch {
  Write-Host ''
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Log: $LogFile" -ForegroundColor Yellow
  exit 1
}
