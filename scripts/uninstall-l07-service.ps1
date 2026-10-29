param([switch]$RemoveState)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Este desinstalador de desarrollo requiere una consola elevada.'
}
$service = Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') { Stop-Service -Name NexoEndpoint -Force }
  & sc.exe delete NexoEndpoint
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo eliminar el servicio.' }
}
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$binary = Join-Path $programFiles 'NEXO\nexo-agent.exe'
Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue
if ($RemoveState) {
  throw 'El estado contiene la identidad del endpoint. Revoca el dispositivo en el portal antes de eliminarlo manualmente.'
}
Write-Output 'Servicio y binario retirados. La identidad local se conservó para retorno o reinstalación explícita.'
