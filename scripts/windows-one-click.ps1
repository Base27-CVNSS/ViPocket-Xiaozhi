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
$PidFile = Join-Path $StateDir 'portable.pid'
$BundledRuntime = Join-Path $Root 'runtime'
$DownloadedRuntime = Join-Path $StateDir 'runtime'
$RunnerPath = Join-Path $Root 'scripts\portable-runner.mjs'
$WebUrl = 'http://127.0.0.1:5173'
$GatewayHealthUrl = 'http://127.0.0.1:8787/health'
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
    $raw = (& $NodePath -p 'process.versions.node').Trim()
    return [Version]$raw
  } catch {
    return $null
  }
}

function New-RuntimeResult {
  param([string]$NodePath, [string]$NpmPath, [string]$Source)
  return [PSCustomObject]@{
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
  Write-Step 'Khong tim thay Node.js phu hop. Dang tai Node.js LTS portable, khong can quyen Admin...'

  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $release = $releases |
    Where-Object {
      $_.lts -and
      $_.files -contains 'win-x64-zip' -and
      ([Version]($_.version.TrimStart('v'))) -ge $MinimumNode
    } |
    Select-Object -First 1

  if (-not $release) {
    throw 'Khong tim thay ban Node.js LTS win-x64 phu hop tren nodejs.org.'
  }

  $versionText = $release.version
  $zipName = "node-$versionText-win-x64.zip"
  $downloadUrl = "https://nodejs.org/dist/$versionText/$zipName"
  $zipPath = Join-Path $StateDir $zipName
  $extractPath = Join-Path $StateDir 'node-extract'

  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $DownloadedRuntime -Recurse -Force -ErrorAction SilentlyContinue

  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath -TimeoutSec 180
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
  $folder = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if (-not $folder) { throw 'Goi Node.js portable khong co thu muc runtime hop le.' }

  Move-Item -LiteralPath $folder.FullName -Destination $DownloadedRuntime
  Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

  $runtime = Test-RuntimeFolder -Folder $DownloadedRuntime -Source 'downloaded-portable'
  if (-not $runtime) { throw 'Node.js portable tai ve khong khoi dong duoc.' }
  Write-Ok "Da tai Node.js $($runtime.Version) portable."
  return $runtime
}

function Resolve-NodeRuntime {
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

function Ensure-EnvironmentFile {
  $envFile = Join-Path $Root '.env'
  $exampleFile = Join-Path $Root '.env.example'
  if (-not (Test-Path $envFile)) {
    if (-not (Test-Path $exampleFile)) { throw 'Thieu tep .env.example.' }
    Copy-Item -LiteralPath $exampleFile -Destination $envFile
    Write-Ok 'Da tao .env. Website local co the chay ngay.'
  }
}

function Test-PortableFiles {
  return (
    (Test-Path (Join-Path $Root 'node_modules\fastify')) -and
    (Test-Path (Join-Path $Root 'apps\web\dist\index.html')) -and
    (Test-Path $RunnerPath)
  )
}

function Ensure-ApplicationFiles {
  param([PSCustomObject]$Runtime)

  $nodeModules = Join-Path $Root 'node_modules'
  $webDist = Join-Path $Root 'apps\web\dist'

  if ($Repair) {
    Write-Step 'Che do sua loi: dang xoa dependency va web build cu...'
    Remove-Item -LiteralPath $nodeModules -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $webDist -Recurse -Force -ErrorAction SilentlyContinue
  }

  if (Test-PortableFiles) {
    Write-Ok 'Runtime, dependency va web build da san sang. Khong can npm install.'
    return
  }

  if (-not $Runtime.Npm -or -not (Test-Path $Runtime.Npm)) {
    throw 'Ban tai ve khong co dependency san va runtime khong co npm de tu sua. Hay tai lai goi Windows Portable.'
  }

  Write-Step 'Dang cai dependency lan dau...'
  & $Runtime.Npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install that bai voi ma loi $LASTEXITCODE." }

  Write-Step 'Dang build giao dien production...'
  & $Runtime.Npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build that bai voi ma loi $LASTEXITCODE." }

  if (-not (Test-PortableFiles)) {
    throw 'Cai dat hoan tat nhung van thieu node_modules hoac apps\web\dist\index.html.'
  }
  Write-Ok 'Da cai va build ViPocket thanh cong.'
}

function Test-Gateway {
  try {
    $health = Invoke-RestMethod -Uri $GatewayHealthUrl -TimeoutSec 2
    return ($health.ok -eq $true -and $health.service -eq 'vipocket-gateway')
  } catch {
    return $false
  }
}

function Test-Web {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $WebUrl -TimeoutSec 2
    return ($response.StatusCode -eq 200 -and $response.Content -match 'ViPocket')
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
      & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-Application {
  param([PSCustomObject]$Runtime)

  $webReady = Test-Web
  $gatewayReady = Test-Gateway
  if ($webReady -and $gatewayReady) {
    Write-Ok 'ViPocket dang chay san.'
    return
  }

  if ($webReady -xor $gatewayReady) {
    Stop-TrackedProcess
    $webReady = Test-Web
    $gatewayReady = Test-Gateway
    if ($webReady -xor $gatewayReady) {
      throw 'Cong 5173 hoac 8787 dang bi mot ung dung khac chiem. Hay dong ung dung do roi chay lai.'
    }
  }

  Stop-TrackedProcess
  Set-Content -LiteralPath $LogFile -Value "ViPocket startup: $(Get-Date -Format o)" -Encoding UTF8
  Write-Step 'Dang khoi dong website va gateway production...'

  $command = '"{0}" "{1}" 1>>"{2}" 2>&1' -f $Runtime.Node, $RunnerPath, $LogFile
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $command) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(180)
  do {
    Start-Sleep -Seconds 1
    if ($process.HasExited) {
      $tail = if (Test-Path $LogFile) { (Get-Content -LiteralPath $LogFile -Tail 45) -join [Environment]::NewLine } else { 'Khong co log.' }
      throw "Tien trinh ViPocket da dung som.`n`n$tail"
    }
    $webReady = Test-Web
    $gatewayReady = Test-Gateway
  } until (($webReady -and $gatewayReady) -or (Get-Date) -ge $deadline)

  if (-not ($webReady -and $gatewayReady)) {
    $tail = if (Test-Path $LogFile) { (Get-Content -LiteralPath $LogFile -Tail 45) -join [Environment]::NewLine } else { 'Khong co log.' }
    throw "Qua thoi gian cho website/gateway.`n`n$tail"
  }

  Write-Ok "Website: $WebUrl"
  Write-Ok "Gateway: $GatewayHealthUrl"
}

try {
  Write-Host '============================================================' -ForegroundColor DarkCyan
  Write-Host ' ViPocket-Xiaozhi 2.1 - WINDOWS ONE CLICK' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor DarkCyan

  if (-not (Test-Path $RunnerPath)) { throw "Thieu $RunnerPath" }
  Ensure-EnvironmentFile
  $runtime = Resolve-NodeRuntime
  Write-Ok "Node.js $($runtime.Version) ($($runtime.Source))."
  Ensure-ApplicationFiles -Runtime $runtime
  Start-Application -Runtime $runtime

  if (-not $NoBrowser) {
    Write-Step 'Dang mo ViPocket trong trinh duyet...'
    Start-Process $WebUrl
  }

  Write-Host ''
  Write-Host 'ViPocket da san sang. Co the dong cua so nay.' -ForegroundColor Green
  Write-Host 'De dung he thong: nhap dup STOP-VIPOCKET.cmd' -ForegroundColor Gray
  Write-Host 'De cau hinh Xiaozhi that: nhap dup CONFIGURE-XIAOZHI.cmd' -ForegroundColor Gray
  Start-Sleep -Seconds 4
  exit 0
} catch {
  Write-Host ''
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Nhat ky: $LogFile" -ForegroundColor Yellow
  exit 1
}
