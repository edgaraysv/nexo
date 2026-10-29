param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$result = 'C:\laragon\tmp\nexo-l07-cleanup-result.txt'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
  Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Elevated' -f $MyInvocation.MyCommand.Path
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $result)) { throw 'No se completó la limpieza elevada.' }
  Get-Content -LiteralPath $result
  exit 0
}
if (-not $isAdmin) { throw 'La limpieza requiere elevación.' }
& 'C:\laragon\www\nexo\scripts\uninstall-l07-service.ps1'
if (Get-Service NexoEndpoint -ErrorAction SilentlyContinue) { throw 'El servicio permanece registrado.' }
'NexoEndpoint cleanup PASS' | Set-Content -LiteralPath $result -Encoding UTF8
