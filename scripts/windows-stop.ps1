$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root '.vipocket\dev.pid'

try {
  if (-not (Test-Path $PidFile)) {
    Write-Host '[ViPocket] Khong tim thay tien trinh dang duoc theo doi.' -ForegroundColor Yellow
    exit 0
  }

  $savedPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($savedPid -notmatch '^\d+$') {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    throw 'Tep PID khong hop le.'
  }

  $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "[ViPocket] Dang dung tien trinh PID $savedPid..." -ForegroundColor Cyan
    & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
    Start-Sleep -Seconds 1
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host '[OK] Da dung ViPocket-Xiaozhi.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host ('[LOI] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
