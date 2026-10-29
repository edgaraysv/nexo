param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [Parameter(Mandatory = $true)][string]$ClientPath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) { throw 'No se encontró el agente Windows.' }
if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw 'No se encontró el cliente Tauri.' }
$stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ('nexo-l07-client-' + [Guid]::NewGuid().ToString('N'))
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipePath = '\\.\pipe\nexo-endpoint-v1'
New-Item -ItemType Directory -Path $stateDir | Out-Null
$agent = $null
$client = $null
try {
  $agent = Start-Process -FilePath $AgentPath -ArgumentList @('service', 'http://127.0.0.1:1', $stateDir, $pipePath, $sid) -PassThru -WindowStyle Hidden
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(5000)
  $pipe.Dispose()
  $client = Start-Process -FilePath $ClientPath -PassThru
  Start-Sleep -Seconds 5
  if ($client.HasExited) { throw 'El cliente Tauri terminó durante el arranque.' }
  Stop-Process -Id $client.Id
  $client.WaitForExit(5000) | Out-Null
  if ($agent.HasExited) { throw 'Cerrar la interfaz detuvo el servicio.' }
  $probe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $probe.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($probe)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($probe)
    $writer.WriteLine('{"version":1,"id":"client_close_01","action":"status"}')
    $response = $reader.ReadLine() | ConvertFrom-Json
    if (-not $response.ok -or $response.data.service -ne 'running') { throw 'El servicio no respondió después de cerrar la UI.' }
  } finally {
    $probe.Dispose()
  }
  [pscustomobject]@{ tauri_native_launch = 'PASS'; ui_close_keeps_service = 'PASS'; service_after_close = 'PASS' } | ConvertTo-Json -Compress
} finally {
  if ($client -and -not $client.HasExited) { Stop-Process -Id $client.Id -Force }
  if ($agent -and -not $agent.HasExited) { Stop-Process -Id $agent.Id -Force }
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
