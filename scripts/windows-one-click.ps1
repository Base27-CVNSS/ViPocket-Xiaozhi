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
$LogFile = Join-Path $LogDir 'vipocket.log'
$PidFile = Join-Path $StateDir 'standalone.pid'
$BundledRuntime = Join-Path $Root 'runtime'
$DownloadedRuntime = Join-Path $StateDir 'runtime'
$EntryPoint = Join-Path $Root 'apps\gateway\src\standalone.mjs'
$AppUrl = 'http://127.0.0.1:5173'
$HealthUrl = 'http://127.0.0.1:5173/health'
$MinimumNode = [Version]'20.11.0'

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
Set-Location $Root

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host ('[ViPocket] ' + $Text) -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
  Write-Host ('[OK] ' + $Text) -ForegroundColor Green
}

function Get-NodeVersion([string]$NodePath) {
  if (-not $NodePath -or -not (Test-Path $NodePath)) { return $null }
  try { return [Version]((& $NodePath -p 'process.versions.node').Trim()) } catch { return $null }
}

function New-Runtime([string]$NodePath, [string]$NpmPath, [string]$Source) {
  return [PSCustomObject]@{
    Node = $NodePath
    Npm = $NpmPath
    Source = $Source
    Version = Get-NodeVersion $NodePath
  }
}

function Test-RuntimeFolder([string]$Folder, [string]$Source) {
  $node = Join-Path $Folder 'node.exe'
  $npm = Join-Path $Folder 'npm.cmd'
  $version = Get-NodeVersion $node
  if ($version -and $version -ge $MinimumNode) {
    return New-Runtime $node $(if (Test-Path $npm) { $npm } else { '' }) $Source
  }
  return $null
}

function Download-PortableNode {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Step 'Dang tai Node.js LTS portable; khong can quyen Admin...'
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $release = $releases |
    Where-Object {
      $_.lts -and
      $_.files -contains 'win-x64-zip' -and
      ([Version]($_.version.TrimStart('v'))) -ge $MinimumNode
    } |
    Select-Object -First 1
  if (-not $release) { throw 'Khong tim thay Node.js LTS win-x64 portable.' }

  $versionText = $release.version
  $zipName = "node-$versionText-win-x64.zip"
  $zipPath = Join-Path $StateDir $zipName
  $extractPath = Join-Path $StateDir 'node-extract'
  $url = "https://nodejs.org/dist/$versionText/$zipName"

  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $DownloadedRuntime -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath -TimeoutSec 180
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
  $folder = Get-ChildItem $extractPath -Directory | Select-Object -First 1
  if (-not $folder) { throw 'Goi Node.js portable khong hop le.' }
  Move-Item $folder.FullName $DownloadedRuntime
  Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

  $runtime = Test-RuntimeFolder $DownloadedRuntime 'downloaded-portable'
  if (-not $runtime) { throw 'Node.js portable khong khoi dong duoc.' }
  return $runtime
}

function Resolve-Runtime {
  $runtime = Test-RuntimeFolder $BundledRuntime 'bundled-portable'
  if ($runtime) { return $runtime }

  $runtime = Test-RuntimeFolder $DownloadedRuntime 'downloaded-portable'
  if ($runtime) { return $runtime }

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($systemNode) {
    $version = Get-NodeVersion $systemNode.Source
    if ($version -and $version -ge $MinimumNode) {
      return New-Runtime $systemNode.Source $(if ($systemNpm) { $systemNpm.Source } else { '' }) 'system'
    }
  }

  return Download-PortableNode
}

function Ensure-Environment {
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root '.env.example') $envFile
    Write-Ok 'Da tao .env mac dinh.'
  }
}

function Test-AppFiles {
  return (
    (Test-Path $EntryPoint) -and
    (Test-Path (Join-Path $Root 'apps\web\index.html')) -and
    (Test-Path (Join-Path $Root 'node_modules\ws'))
  )
}

function Ensure-AppFiles([PSCustomObject]$Runtime) {
  $nodeModules = Join-Path $Root 'node_modules'
  if ($Repair) {
    Write-Step 'Dang xoa dependency cu...'
    Remove-Item $nodeModules -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-AppFiles) {
    Write-Ok 'Mã nguồn và dependency đã sẵn sàng.'
    return
  }
  if (-not $Runtime.Npm -or -not (Test-Path $Runtime.Npm)) {
    throw 'Goi tai ve thieu node_modules/ws va runtime khong co npm. Hay tai lai artifact Windows Portable.'
  }
  Write-Step 'Dang cai dependency duy nhat ws...'
  & $Runtime.Npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install that bai: $LASTEXITCODE" }
  if (-not (Test-AppFiles)) { throw 'Sau khi cai dat van thieu file bat buoc.' }
  Write-Ok 'Dependency da san sang.'
}

function Test-Health {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    return ($health.ok -eq $true -and $health.service -eq 'vipocket-standalone')
  } catch { return $false }
}

function Test-Website {
  try {
    $page = Invoke-WebRequest -UseBasicParsing -Uri $AppUrl -TimeoutSec 2
    return ($page.StatusCode -eq 200 -and $page.Content -match 'ViPocket')
  } catch { return $false }
}

function Stop-TrackedProcess {
  if (-not (Test-Path $PidFile)) { return }
  $savedPid = (Get-Content $PidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($process) {
      & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
      Start-Sleep -Milliseconds 800
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-App([PSCustomObject]$Runtime) {
  if ((Test-Health) -and (Test-Website)) {
    Write-Ok 'ViPocket dang chay san.'
    return
  }

  Stop-TrackedProcess
  if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 5173 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    throw 'Cong 5173 dang bi ung dung khac su dung. Hay dong ung dung do roi chay lai.'
  }

  Set-Content $LogFile "ViPocket startup: $(Get-Date -Format o)" -Encoding UTF8
  Write-Step 'Dang khoi dong website va gateway trong mot tien trinh...'
  $command = '"{0}" "{1}" 1>>"{2}" 2>&1' -f $Runtime.Node, $EntryPoint, $LogFile
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $command) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Set-Content $PidFile $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
      $tail = if (Test-Path $LogFile) { (Get-Content $LogFile -Tail 60) -join [Environment]::NewLine } else { 'Khong co log.' }
      throw "ViPocket dung som.`n`n$tail"
    }
  } until (((Test-Health) -and (Test-Website)) -or (Get-Date) -ge $deadline)

  if (-not ((Test-Health) -and (Test-Website))) {
    $tail = if (Test-Path $LogFile) { (Get-Content $LogFile -Tail 60) -join [Environment]::NewLine } else { 'Khong co log.' }
    throw "Qua thoi gian cho khoi dong.`n`n$tail"
  }
  Write-Ok "ViPocket: $AppUrl"
}

try {
  Write-Host '============================================================' -ForegroundColor DarkCyan
  Write-Host ' ViPocket-Xiaozhi 2.2 - ONE PROCESS / ONE PORT' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor DarkCyan

  Ensure-Environment
  $runtime = Resolve-Runtime
  Write-Ok "Node.js $($runtime.Version) ($($runtime.Source))."
  Ensure-AppFiles $runtime
  Start-App $runtime

  if (-not $NoBrowser) { Start-Process $AppUrl }
  Write-Host ''
  Write-Host 'ViPocket da san sang. Co the dong cua so nay.' -ForegroundColor Green
  Write-Host 'Dung he thong: STOP-VIPOCKET.cmd' -ForegroundColor Gray
  Write-Host 'Cau hinh Xiaozhi: CONFIGURE-XIAOZHI.cmd' -ForegroundColor Gray
  Start-Sleep -Seconds 3
  exit 0
} catch {
  Write-Host ''
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Nhat ky: $LogFile" -ForegroundColor Yellow
  exit 1
}
