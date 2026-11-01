$ErrorActionPreference = 'Stop'
$agent = 'C:\laragon\www\nexo\product\agent\bin\nexo-agent.exe'
$agentUpdater = 'C:\laragon\www\nexo\product\agent\bin\nexo-agent-updater.exe'
if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) { throw 'Falta product\agent\bin\nexo-agent.exe; ejecuta npm run verify:l07 primero.' }
if (-not (Test-Path -LiteralPath $agentUpdater -PathType Leaf)) { throw 'Falta product\agent\bin\nexo-agent-updater.exe; ejecuta npm run verify:l07 primero.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'No se encontró el workload C++ de escritorio.' }
$devShell = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$command = 'call "{0}" -arch=amd64 -host_arch=amd64 >nul && set "PATH=%USERPROFILE%\.cargo\bin;%PATH%" && cd /d "C:\laragon\www\nexo\product\client" && npm.cmd run tauri -- build' -f $devShell
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el instalador NSIS.' }
