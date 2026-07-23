$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'FengSheng Werewolf - Stop'

Write-Host 'Stopping services...'

Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

try {
  $conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if ($c.OwningProcess) {
      Write-Host ("Stopping PID " + $c.OwningProcess)
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}

# Also stop npm/node that may still be around for this project
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'fengsheng-werewolf|server\\index\.js|狼人杀webonline' } |
  ForEach-Object {
    Write-Host ("Stopping " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Write-Host 'Done. Game server and Cloudflare tunnel stopped.'
