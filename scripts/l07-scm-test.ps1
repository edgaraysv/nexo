param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$resultPath = 'C:\laragon\tmp\nexo-l07-scm-result.json'
$errorPath = 'C:\laragon\tmp\nexo-l07-scm-error.txt'
trap {
  if ($Elevated) { ($_ | Out-String) | Set-Content -LiteralPath $errorPath -Encoding UTF8 }
  exit 1
}
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($current)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
  Remove-Item -LiteralPath $resultPath, $errorPath -Force -ErrorAction SilentlyContinue
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -AgentPath "{1}" -Elevated' -f $scriptPath, $AgentPath
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) {
    $detail = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { 'UAC cancelado o proceso elevado sin resultado.' }
    throw "La prueba elevada SCM no se completó: $detail"
  }
  Get-Content -LiteralPath $resultPath -Raw
  exit 0
}
if (-not $isAdmin) { throw 'La prueba SCM requiere elevación.' }
if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'NexoEndpoint ya existe; no se alteró.' }
$sid = $current.User.Value
$installed = $false
try {
  & 'C:\laragon\www\nexo\scripts\install-l07-service.ps1' -AgentPath $AgentPath -ApiBase 'http://127.0.0.1:1' -AllowedSid $sid
  $installed = $true
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  Restart-Service -Name NexoEndpoint -Force
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($pipe)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($pipe)
    $writer.WriteLine('{"version":1,"id":"scm_restart_01","action":"status"}')
    $response = $reader.ReadLine() | ConvertFrom-Json
    if (-not $response.ok -or $response.data.service -ne 'running') { throw 'El servicio reiniciado no respondió por IPC.' }
  } finally {
    $pipe.Dispose()
  }
  & 'C:\laragon\www\nexo\scripts\uninstall-l07-service.ps1'
  $installed = $false
  if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'El servicio no fue retirado.' }
  if (-not (Test-Path -LiteralPath 'C:\ProgramData\NEXO\Endpoint\device-key')) { throw 'La desinstalación eliminó la identidad local.' }
  [pscustomobject]@{ scm_install = 'PASS'; scm_restart = 'PASS'; ipc_after_restart = 'PASS'; uninstall_preserves_identity = 'PASS' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
} finally {
  if ($installed -and (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue)) {
    Stop-Service -Name NexoEndpoint -Force -ErrorAction SilentlyContinue
    & sc.exe delete NexoEndpoint | Out-Null
  }
}
