param([Parameter(Mandatory = $true)][string]$AgentPath)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ('nexo-l07-' + [Guid]::NewGuid().ToString('N'))
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipe = '\\.\pipe\nexo-endpoint-v1'
New-Item -ItemType Directory -Path $stateDir | Out-Null
$process = $null
try {
  $arguments = @('service', 'http://127.0.0.1:1', $stateDir, $pipe, $sid)
  $process = Start-Process -FilePath $AgentPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $responses = @()
  foreach ($index in 1..2) {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
    try {
      $client.Connect(5000)
      $writer = [System.IO.StreamWriter]::new($client)
      $writer.AutoFlush = $true
      $reader = [System.IO.StreamReader]::new($client)
      $writer.WriteLine('{"version":1,"id":"native_0' + $index + '","action":"status"}')
      $responses += ($reader.ReadLine() | ConvertFrom-Json)
    } finally {
      $client.Dispose()
    }
  }
  if ($responses.Count -ne 2 -or $responses.Where({ -not $_.ok }).Count -ne 0) { throw 'El IPC no respondió dos veces.' }
  $serialized = $responses | ConvertTo-Json -Depth 8 -Compress
  if ($serialized -match 'PRIVATE KEY|claim_token|certificate_pem|bearer') { throw 'La respuesta IPC contiene material sensible.' }
  $keyBytes = [System.IO.File]::ReadAllBytes((Join-Path $stateDir 'device-key'))
  $keyText = [System.Text.Encoding]::UTF8.GetString($keyBytes)
  if ($keyText -match 'PRIVATE KEY') { throw 'La clave Windows no quedó protegida con DPAPI.' }
  [pscustomobject]@{ windows_ipc = 'PASS'; reconnect_after_ui_close = 'PASS'; dpapi = 'PASS'; principal = $sid } | ConvertTo-Json -Compress
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
