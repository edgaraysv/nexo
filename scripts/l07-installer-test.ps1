param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$resultPath = 'C:\laragon\tmp\nexo-l07-installer-result.json'
$errorPath = 'C:\laragon\tmp\nexo-l07-installer-error.txt'
trap {
  if ($Elevated) { ($_ | Out-String) | Set-Content -LiteralPath $errorPath -Encoding UTF8 }
  exit 1
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
  Remove-Item -LiteralPath $resultPath, $errorPath -Force -ErrorAction SilentlyContinue
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -InstallerPath "{1}" -Elevated' -f $scriptPath, $InstallerPath
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) {
    $detail = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { 'UAC cancelado o instalador sin resultado.' }
    throw "La prueba elevada del instalador no se completó: $detail"
  }
  Get-Content -LiteralPath $resultPath -Raw
  exit 0
}
if (-not $isAdmin) { throw 'La prueba del instalador requiere elevación.' }
if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'NexoEndpoint ya existe; no se alteró.' }
$installDir = Join-Path $env:ProgramFiles 'NEXO Endpoint'
if (Test-Path -LiteralPath $installDir) { throw 'El directorio de cliente ya existe; no se alteró.' }
$installed = $false
try {
  $installer = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "El instalador devolvió $($installer.ExitCode)." }
  $installed = $true
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  $clientPath = Join-Path $installDir 'nexo-client.exe'
  if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) { throw 'La UI no quedó instalada.' }
  $client = Start-Process -FilePath $clientPath -PassThru
  Start-Sleep -Seconds 5
  if ($client.HasExited) { throw 'La UI instalada terminó durante el arranque.' }
  Stop-Process -Id $client.Id
  $client.WaitForExit(5000) | Out-Null
  Restart-Service -Name NexoEndpoint -Force
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'nexo-endpoint-v1', [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($pipe)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($pipe)
    $writer.WriteLine('{"version":1,"id":"installer_01","action":"status"}')
    $response = $reader.ReadLine() | ConvertFrom-Json
    if (-not $response.ok -or $response.data.service -ne 'running') { throw 'El servicio instalado no respondió.' }
  } finally {
    $pipe.Dispose()
  }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "El desinstalador devolvió $($uninstall.ExitCode)." }
  $installed = $false
  if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'El servicio permanece después de desinstalar.' }
  if (-not (Test-Path -LiteralPath 'C:\ProgramData\NEXO\Endpoint\device-key')) { throw 'La desinstalación eliminó la identidad.' }
  [pscustomobject]@{ nsis_install = 'PASS'; installed_ui = 'PASS'; scm_restart = 'PASS'; ipc_after_ui_close = 'PASS'; nsis_uninstall = 'PASS'; identity_preserved = 'PASS' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
} finally {
  if ($installed) {
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null }
  }
}
