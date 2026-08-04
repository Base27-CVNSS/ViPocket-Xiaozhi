$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root '.vipocket\standalone.pid'

function Test-OwnedProcess([int]$ProcessId) {
  try {
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    return ($details -and $details.CommandLine -and $details.CommandLine.Contains($Root))
  } catch { return $false }
}

function Stop-ProcessTree([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process -and (Test-OwnedProcess $ProcessId)) {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    return $true
  }
  return $false
}

function Stop-OwnedPortProcess([int]$Port) {
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $owner = [int]$connection.OwningProcess
      if (Test-OwnedProcess $owner) { Stop-ProcessTree $owner | Out-Null }
    }
  } catch {}
}

try {
  $stopped = $false
  if (Test-Path $PidFile) {
    $savedPid = (Get-Content $PidFile -Raw).Trim()
    if ($savedPid -match '^\d+$') { $stopped = Stop-ProcessTree ([int]$savedPid) }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  Stop-OwnedPortProcess 5173

  if ($stopped) {
    Write-Host '[OK] Da dung ViPocket-Xiaozhi.' -ForegroundColor Green
  } else {
    Write-Host '[ViPocket] Khong con tien trinh ViPocket dang chay.' -ForegroundColor Yellow
  }
  exit 0
} catch {
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
