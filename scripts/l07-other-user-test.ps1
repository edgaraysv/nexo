param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$resultPath = 'C:\laragon\tmp\nexo-l07-other-user-result.json'
$errorPath = 'C:\laragon\tmp\nexo-l07-other-user-error.txt'
trap {
  if ($Elevated) { ($_ | Out-String) | Set-Content -LiteralPath $errorPath -Encoding UTF8 }
  exit 1
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
  Remove-Item -LiteralPath $resultPath, $errorPath -Force -ErrorAction SilentlyContinue
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -AgentPath "{1}" -Elevated' -f $scriptPath, $AgentPath
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) {
    $detail = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { 'UAC cancelado o prueba sin resultado.' }
    throw "La prueba de otro usuario no se completó: $detail"
  }
  Get-Content -LiteralPath $resultPath -Raw
  exit 0
}
if (-not $isAdmin) { throw 'La prueba requiere elevación.' }
if (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue) { throw 'NexoEndpoint ya existe; no se alteró.' }
$username = 'NexoL07' + (Get-Random -Minimum 10000 -Maximum 99999)
$passwordBytes = New-Object byte[] 24
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($passwordBytes)
$rng.Dispose()
$plainPassword = [Convert]::ToBase64String($passwordBytes) + '!aA1'
$password = ConvertTo-SecureString $plainPassword -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential(".\$username", $password)
$userCreated = $false
$serviceInstalled = $false
try {
  New-LocalUser -Name $username -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $userCreated = $true
  & 'C:\laragon\www\nexo\scripts\install-l07-service.ps1' -AgentPath $AgentPath -ApiBase 'http://127.0.0.1:1' -AllowedSid $identity.User.Value
  $serviceInstalled = $true
  $service = Get-Service -Name NexoEndpoint
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  $probe = Start-Process powershell.exe -Credential $credential -LoadUserProfile -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\laragon\www\nexo\scripts\l07-unauthorized-probe.ps1"' -Wait -PassThru
  if ($probe.ExitCode -ne 0) { throw "El principal no autorizado devolvió $($probe.ExitCode); 5 significa acceso indebido y 6 error inconcluso." }
  & 'C:\laragon\www\nexo\scripts\uninstall-l07-service.ps1'
  $serviceInstalled = $false
  Remove-LocalUser -Name $username
  $userCreated = $false
  [pscustomobject]@{ unauthorized_sid = 'DENIED'; temporary_user_removed = 'PASS'; service_removed = 'PASS' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
} finally {
  $plainPassword = $null
  $credential = $null
  if ($serviceInstalled -and (Get-Service -Name NexoEndpoint -ErrorAction SilentlyContinue)) {
    Stop-Service -Name NexoEndpoint -Force -ErrorAction SilentlyContinue
    & sc.exe delete NexoEndpoint | Out-Null
  }
  if ($userCreated -and (Get-LocalUser -Name $username -ErrorAction SilentlyContinue)) { Remove-LocalUser -Name $username }
}
