$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'FengSheng Werewolf - Server'

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = $PSScriptRoot }
Set-Location $root

Write-Host '========================================'
Write-Host '  FengSheng Werewolf - Start'
Write-Host '========================================'
Write-Host ''
Write-Host ("Project: " + $root)
Write-Host ''

function Pause-Exit($code = 1) {
  Write-Host ''
  Write-Host 'Press any key to close...'
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Read-Host 'Enter' }
  exit $code
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] Node.js not found. Install from https://nodejs.org/' -ForegroundColor Red
  Pause-Exit 1
}

$cloudflared = 'C:\cloudflare\cloudflared.exe'
if (-not (Test-Path $cloudflared)) {
  Write-Host '[ERROR] Missing C:\cloudflare\cloudflared.exe' -ForegroundColor Red
  Pause-Exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '[INFO] Installing npm dependencies (first run)...'
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] npm install failed' -ForegroundColor Red
    Pause-Exit 1
  }
  Write-Host ''
}

# Free game port 3080 if occupied (NOT 3000 — that may be Gitea)
try {
  $conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $procId = $c.OwningProcess
    if ($procId) {
      Write-Host "[INFO] Killing process on port 3080 (PID $procId)"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}

Write-Host '[1/2] Starting game server on http://localhost:3080 ...'
$server = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm start' -WorkingDirectory $root -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 3

# Health check
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3080/api/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $ok) {
  Write-Host '[WARN] Health check not ready yet, still starting tunnel...' -ForegroundColor Yellow
} else {
  Write-Host '[OK] Game server is up.' -ForegroundColor Green
}

Write-Host ''
Write-Host '[2/2] Starting Cloudflare tunnel...'
Write-Host '----------------------------------------'
Write-Host ' Find the https://xxxx.trycloudflare.com URL below'
Write-Host ' Share that link with friends to play together'
Write-Host ' Close this window to stop the public tunnel'
Write-Host '----------------------------------------'
Write-Host ''

try {
  & $cloudflared tunnel --url http://localhost:3080
} finally {
  Write-Host ''
  Write-Host 'Tunnel stopped. Stopping game server...'
  try {
    $conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'All stopped.'
  Pause-Exit 0
}
