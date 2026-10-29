param([switch]$Release)

$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Microsoft C++ Build Tools no está instalado.' }
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'No se encontró el workload C++ de escritorio.' }
$devShell = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$project = 'C:\laragon\www\nexo\product\client\src-tauri'
$mode = if ($Release) { 'build --release' } else { 'check' }
$command = 'call "{0}" -arch=amd64 -host_arch=amd64 >nul && cd /d "{1}" && "{2}" {3}' -f $devShell, $project, $cargo, $mode
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Cargo $mode falló." }
