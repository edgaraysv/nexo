param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'NEXO'),
  [string]$StagingDir = (Join-Path $env:ProgramData 'NEXO\Endpoint\updates')
)

$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath (Join-Path $StagingDir 'update-state.json') -Raw | ConvertFrom-Json
if ($state.schema -ne 'nexo.agent-update.v1' -or $state.package -ne 'nexo-agent.pending.exe') { throw 'Estado de actualización inválido.' }
$pending = Join-Path $StagingDir $state.package
$active = Join-Path $InstallDir 'nexo-agent.exe'
$rollback = Join-Path $InstallDir 'nexo-agent.rollback.exe'
if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.sha256) { throw 'Integridad de actualización inválida.' }

Stop-Service -Name NexoEndpoint -Force
Copy-Item -LiteralPath $active -Destination $rollback -Force
Copy-Item -LiteralPath $pending -Destination $active -Force
try {
  Start-Service -Name NexoEndpoint
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  if ($service.Status -ne 'Running') { throw 'El servicio actualizado no inició.' }
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($pipe)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($pipe)
    $writer.WriteLine('{"version":1,"id":"update_health_01","action":"status"}')
    $health = $reader.ReadLine() | ConvertFrom-Json
    if (-not $health.ok -or $health.data.service -ne 'running') { throw 'El IPC actualizado no respondió salud.' }
  } finally {
    $pipe.Dispose()
  }
  Remove-Item -LiteralPath $rollback -Force
  Remove-Item -LiteralPath $pending, (Join-Path $StagingDir 'update-state.json') -Force
  Write-Output 'Actualización aplicada y servicio saludable.'
} catch {
  Stop-Service -Name NexoEndpoint -Force -ErrorAction SilentlyContinue
  if (-not $state.rollback_allowed) { throw 'La actualización falló y la versión anterior está bloqueada; el servicio permanece detenido.' }
  Copy-Item -LiteralPath $rollback -Destination $active -Force
  Start-Service -Name NexoEndpoint
  throw 'La actualización falló; se restauró una versión anterior permitida.'
}
