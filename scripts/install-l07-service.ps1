param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [Parameter(Mandatory = $true)][string]$ApiBase,
  [string]$AllowedSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string]$VpnRemoteHost
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Este instalador de desarrollo requiere una consola elevada.'
}
if (-not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) { throw 'No se encontró el binario del agente.' }
if ($AllowedSid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') { throw 'SID no válido.' }
$uri = [Uri]$ApiBase
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1', 'localhost', '::1'))) {
  throw 'HTTPS es obligatorio fuera de loopback.'
}
if ($VpnRemoteHost -and $VpnRemoteHost -notmatch '^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$') {
  throw 'Host VPN remoto no válido.'
}

$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$installDir = Join-Path $programFiles 'NEXO'
$stateDir = Join-Path $env:ProgramData 'NEXO\Endpoint'
$target = Join-Path $installDir 'nexo-agent.exe'
$openVpn = Join-Path $programFiles 'OpenVPN\bin\openvpn.exe'
if (-not (Test-Path -LiteralPath $openVpn -PathType Leaf)) { throw 'OpenVPN Community no está instalado en la ruta administrada.' }
$openVpnVersion = & $openVpn --version 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or $openVpnVersion -notmatch '^OpenVPN 2\.') { throw 'Se requiere OpenVPN Community 2.x en la ruta administrada.' }
New-Item -ItemType Directory -Force -Path $installDir, $stateDir | Out-Null
& icacls.exe $installDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudo proteger el directorio de instalación.' }
& icacls.exe $stateDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudo proteger el estado del servicio.' }
Copy-Item -LiteralPath $AgentPath -Destination $target -Force
$arguments = '"{0}" windows-service "{1}" "{2}" "{3}"' -f $target, $ApiBase, $stateDir, $AllowedSid
if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'El servicio NexoEndpoint ya existe.' }
New-Service -Name NexoEndpoint -BinaryPathName $arguments -DisplayName 'NEXO Endpoint' -Description 'Servicio de identidad y control del endpoint NEXO.' -StartupType Automatic | Out-Null
& sc.exe description NexoEndpoint 'Servicio de identidad y control del endpoint NEXO.'
if ($VpnRemoteHost) {
  Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\NexoEndpoint' -Name Environment -Type MultiString -Value @("NEXO_VPN_REMOTE_HOST=$VpnRemoteHost")
}
& sc.exe start NexoEndpoint
if ($LASTEXITCODE -ne 0) { throw 'El servicio fue creado pero no pudo iniciarse.' }
Write-Output 'NexoEndpoint instalado e iniciado.'
