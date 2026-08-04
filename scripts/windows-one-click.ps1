[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = '2.2.1'
$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root '.vipocket'
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'vipocket.log'
$ErrorLog = Join-Path $LogDir 'vipocket-error.log'
$PidFile = Join-Path $StateDir 'server.pid'
$BundledRuntime = Join-Path $Root 'runtime'
$DownloadedRuntime = Join-Path $StateDir 'runtime'
$ServerEntry = Join-Path $Root 'apps\gateway\src\index.mjs'
$WebsiteUrl = 'http://127.0.0.1:8787/'
$HealthUrl = 'http://127.0.0.1:8787/health'
$MinimumNode = [Version]'20.11.0'

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

function Get-NodeVersion {
  param([string]$NodePath)
  if (-not $NodePath -or -not (Test-Path $NodePath)) { return $null }
  try {
    return [Version]((& $NodePath -p 'process.versions.node').Trim())
  } catch {
    return $null
  }
}

function New-RuntimeResult {
  param([string]$NodePath, [string]$NpmPath, [string]$Source)
  [PSCustomObject]@{
    Node = $NodePath
    Npm = $NpmPath
    Source = $Source
    Version = Get-NodeVersion -NodePath $NodePath
  }
}

function Test-RuntimeFolder {
  param([string]$Folder, [string]$Source)
  $node = Join-Path $Folder 'node.exe'
  $npm = Join-Path $Folder 'npm.cmd'
  $version = Get-NodeVersion -NodePath $node
  if ($version -and $version -ge $MinimumNode) {
    return New-RuntimeResult -NodePath $node -NpmPath $(if (Test-Path $npm) { $npm } else { '' }) -Source $Source
  }
  return $null
}

function Download-PortableNode {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Step 'Dang tai Node.js LTS portable. Khong can quyen Admin...'
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $release = $releases |
    Where-Object {
      $_.lts -and
      $_.files -contains 'win-x64-zip' -and
      ([Version]($_.version.TrimStart('v'))) -ge $MinimumNode
    } |
    Select-Object -First 1
  if (-not $release) { throw 'Khong tim thay Node.js LTS win-x64 phu hop.' }

  $zipName = "node-$($release.version)-win-x64.zip"
  $zipPath = Join-Path $StateDir $zipName
  $extractPath = Join-Path $StateDir 'node-extract'
  $downloadUrl = "https://nodejs.org/dist/$($release.version)/$zipName"

  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $DownloadedRuntime -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath -TimeoutSec 240
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
  $folder = Get-ChildItem $extractPath -Directory | Select-Object -First 1
  if (-not $folder) { throw 'Goi Node.js portable khong hop le.' }
  Move-Item $folder.FullName $DownloadedRuntime
  Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

  $runtime = Test-RuntimeFolder -Folder $DownloadedRuntime -Source 'downloaded-portable'
  if (-not $runtime) { throw 'Node.js portable khong khoi dong duoc.' }
  return $runtime
}

function Resolve-Runtime {
  $runtime = Test-RuntimeFolder -Folder $BundledRuntime -Source 'bundled-portable'
  if ($runtime) { return $runtime }

  $runtime = Test-RuntimeFolder -Folder $DownloadedRuntime -Source 'downloaded-portable'
  if ($runtime) { return $runtime }

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($systemNode -and $systemNpm) {
    $version = Get-NodeVersion -NodePath $systemNode.Source
    if ($version -and $version -ge $MinimumNode) {
      return New-RuntimeResult -NodePath $systemNode.Source -NpmPath $systemNpm.Source -Source 'system'
    }
  }
  return Download-PortableNode
}

function Ensure-Environment {
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    $example = Join-Path $Root '.env.example'
    if (-not (Test-Path $example)) { throw 'Thieu .env.example.' }
    Copy-Item $example $envFile
    Write-Ok 'Da tao .env mac dinh.'
  }
}

function Test-AppFiles {
  (Test-Path $ServerEntry) -and
  (Test-Path (Join-Path $Root 'apps\web\dist\index.html')) -and
  (Test-Path (Join-Path $Root 'node_modules\ws'))
}

function Ensure-AppFiles {
  param([PSCustomObject]$Runtime)
  if ($Repair) {
    Write-Step 'Dang xoa dependency va web build cu...'
    Remove-Item (Join-Path $Root 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Root 'apps\web\dist') -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-AppFiles) {
    Write-Ok 'Web build va runtime dependency da san sang.'
    return
  }
  if (-not $Runtime.Npm -or -not (Test-Path $Runtime.Npm)) {
    throw 'Goi tai ve bi thieu dependency. Hay tai lai Windows Portable hoac chay tren may co npm.'
  }
  Write-Step 'Dang cai dependency...'
  & $Runtime.Npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install that bai: $LASTEXITCODE" }
  Write-Step 'Dang build website production...'
  & $Runtime.Npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build that bai: $LASTEXITCODE" }
  if (-not (Test-AppFiles)) { throw 'Sau khi build van thieu file runtime.' }
}

function Test-Website {
  try {
    $web = Invoke-WebRequest -UseBasicParsing -Uri $WebsiteUrl -TimeoutSec 2
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    return ($web.StatusCode -eq 200 -and $web.Content -match 'ViPocket' -and $health.ok -eq $true)
  } catch {
    return $false
  }
}

function Get-StartupLogTail {
  $parts = @()
  if (Test-Path $LogFile) {
    $parts += '--- vipocket.log ---'
    $parts += (Get-Content $LogFile -Tail 80)
  }
  if (Test-Path $ErrorLog) {
    $parts += '--- vipocket-error.log ---'
    $parts += (Get-Content $ErrorLog -Tail 80)
  }
  if ($parts.Count -eq 0) { return 'Khong co log khoi dong.' }
  return ($parts -join [Environment]::NewLine)
}

function Stop-TrackedProcess {
  if (-not (Test-Path $PidFile)) { return }
  $savedPid = (Get-Content $PidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($details -and $details.CommandLine -and $details.CommandLine.Contains($Root)) {
      & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
      Start-Sleep -Seconds 1
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-App {
  param([PSCustomObject]$Runtime)
  if (Test-Website) {
    Write-Ok "ViPocket dang chay tai $WebsiteUrl"
    return
  }

  Stop-TrackedProcess
  Remove-Item $LogFile, $ErrorLog -Force -ErrorAction SilentlyContinue
  Write-Step 'Dang khoi dong website va gateway tren cung cong 8787...'

  # Start Node directly. The previous cmd.exe /c wrapper could exit immediately
  # when node.exe was installed under a path containing spaces such as
  # C:\Program Files\nodejs, leaving an empty log and ERR_CONNECTION_REFUSED.
  $quotedEntry = '"{0}"' -f $ServerEntry
  $process = Start-Process \
    -FilePath $Runtime.Node \
    -ArgumentList $quotedEntry \
    -WorkingDirectory $Root \
    -WindowStyle Hidden \
    -RedirectStandardOutput $LogFile \
    -RedirectStandardError $ErrorLog \
    -PassThru

  Set-Content $PidFile $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Seconds 1
    $process.Refresh()
    if ($process.HasExited) {
      Start-Sleep -Milliseconds 300
      throw "ViPocket da dung som (exit code $($process.ExitCode)).`n`n$(Get-StartupLogTail)"
    }
  } until ((Test-Website) -or (Get-Date) -ge $deadline)

  if (-not (Test-Website)) {
    throw "Qua thoi gian cho ViPocket.`n`n$(Get-StartupLogTail)"
  }
  Write-Ok "Website va gateway: $WebsiteUrl"
}

try {
  Write-Host '============================================================' -ForegroundColor DarkCyan
  Write-Host " ViPocket-Xiaozhi $Version - WINDOWS ONE CLICK" -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor DarkCyan

  Ensure-Environment
  $runtime = Resolve-Runtime
  Write-Ok "Node.js $($runtime.Version) ($($runtime.Source))."
  Ensure-AppFiles -Runtime $runtime
  Start-App -Runtime $runtime

  if (-not $NoBrowser) {
    Write-Step 'Dang mo ViPocket...'
    Start-Process $WebsiteUrl
  }

  Write-Host ''
  Write-Host 'ViPocket da san sang. Co the dong cua so nay.' -ForegroundColor Green
  Write-Host 'Dung he thong: STOP-VIPOCKET.cmd' -ForegroundColor Gray
  Write-Host 'Cau hinh Xiaozhi: CONFIGURE-XIAOZHI.cmd' -ForegroundColor Gray
  Start-Sleep -Seconds 4
  exit 0
} catch {
  Write-Host ''
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Nhat ky thuong: $LogFile" -ForegroundColor Yellow
  Write-Host "Nhat ky loi:    $ErrorLog" -ForegroundColor Yellow
  exit 1
}
