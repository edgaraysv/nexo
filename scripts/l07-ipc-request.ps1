param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$request = [ordered]@{ version = 1; id = 'flow_' + [Guid]::NewGuid().ToString('N'); action = $Action }
if ($PayloadBase64) {
  $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  $request.payload = $payloadJson | ConvertFrom-Json
}
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(5000)
  $writer = [System.IO.StreamWriter]::new($pipe)
  $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new($pipe)
  $writer.WriteLine(($request | ConvertTo-Json -Depth 6 -Compress))
  $reader.ReadLine()
} finally {
  $pipe.Dispose()
}
