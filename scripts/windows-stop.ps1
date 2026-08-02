$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root '.vipocket\portable.pid'

function Stop-ProcessTree {
  param([int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    return $true
  }
  return $false
}

function Stop-OwnedPortProcess {
  param([int]$Port)
  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $pidValue = [int]$connection.OwningProcess
      $details = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
      if ($details -and $details.CommandLine -and $details.CommandLine.Contains($Root)) {
        Stop-ProcessTree -ProcessId $pidValue | Out-Null
      }
    }
  } catch {
    # The PID file remains the primary shutdown path. Port recovery is best effort.
  }
}

try {
  $stopped = $false
  if (Test-Path $PidFile) {
    $savedPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($savedPid -match '^\d+$') {
      $stopped = Stop-ProcessTree -ProcessId ([int]$savedPid)
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }

  Stop-OwnedPortProcess -Port 5173
  Stop-OwnedPortProcess -Port 8787

  if ($stopped) {
    Write-Host '[OK] Da dung ViPocket-Xiaozhi va toan bo tien trinh con.' -ForegroundColor Green
  } else {
    Write-Host '[ViPocket] Khong con tien trinh ViPocket dang chay.' -ForegroundColor Yellow
  }
  exit 0
} catch {
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
