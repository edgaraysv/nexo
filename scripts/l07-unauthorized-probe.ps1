$ErrorActionPreference = 'Stop'
try {
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(3000)
    exit 5
  } finally {
    $pipe.Dispose()
  }
} catch [System.UnauthorizedAccessException] {
  exit 0
} catch {
  exit 6
}
