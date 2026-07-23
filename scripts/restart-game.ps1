$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'FengSheng - Restart Game Only'

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = $PSScriptRoot }
Set-Location $root

Write-Host '========================================'
Write-Host '  Restart GAME server only'
Write-Host '  (Cloudflare tunnel kept running)'
Write-Host '========================================'
Write-Host ''

# Only free port 3080 — do NOT touch 3000 (Gitea) or cloudflared
try {
  $conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $procId = $c.OwningProcess
    if ($procId) {
      Write-Host "[INFO] Stopping old game server PID $procId"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'server\\index\.js' -and $_.CommandLine -notmatch 'cloudflared' } |
  ForEach-Object {
    Write-Host ("[INFO] Stopping node " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 1

Write-Host '[INFO] Starting npm start ...'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $root -WindowStyle Minimized

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3080/api/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Host ''
      Write-Host '[OK] Game server is up on http://localhost:3080' -ForegroundColor Green
      Write-Host $r.Content
      Write-Host ''
      Write-Host 'Cloudflare link is UNCHANGED if the tunnel window is still open.'
      Write-Host 'Just refresh the browser (Ctrl+F5).'
      $ok = $true
      break
    }
  } catch {}
}

if (-not $ok) {
  Write-Host '[ERROR] Game server failed to start' -ForegroundColor Red
  Write-Host 'Press any key to close...'
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Read-Host 'Enter' }
  exit 1
}

Start-Sleep -Seconds 2
