param(
  [Parameter(Mandatory = $true)][string]$AgentPath,
  [Parameter(Mandatory = $true)][string]$ClientPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NexoWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
$stateDir = Join-Path ([IO.Path]::GetTempPath()) ('nexo-l07-ui-' + [Guid]::NewGuid().ToString('N'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory -Path $stateDir | Out-Null
$agent = $null
$client = $null
$previousScale = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try {
  $agent = Start-Process -FilePath $AgentPath -ArgumentList @('service', 'http://127.0.0.1:1', $stateDir, '\\.\pipe\nexo-endpoint-v1', $sid) -PassThru -WindowStyle Hidden
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-device-scale-factor=2'
  $client = Start-Process -FilePath $ClientPath -PassThru
  $rect = New-Object NexoWindowCapture+RECT
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $client.Refresh()
    if ($client.MainWindowHandle -ne [IntPtr]::Zero -and [NexoWindowCapture]::GetWindowRect($client.MainWindowHandle, [ref]$rect) -and ($rect.Right - $rect.Left) -gt 300) { break }
  }
  if ($client.MainWindowHandle -eq [IntPtr]::Zero) { throw 'La ventana Tauri no estuvo disponible.' }
  if (-not [NexoWindowCapture]::GetWindowRect($client.MainWindowHandle, [ref]$rect)) { throw 'No se pudo medir la ventana.' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 300 -or $height -le 300) { throw 'La ventana Tauri no alcanzó un tamaño capturable.' }
  [NexoWindowCapture]::SetForegroundWindow($client.MainWindowHandle) | Out-Null
  Start-Sleep -Seconds 2
  $bitmap = New-Object Drawing.Bitmap($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object Drawing.Size($width, $height)))
  } finally {
    $graphics.Dispose()
  }
  $directory = Split-Path -Parent $OutputPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  [pscustomobject]@{ ui_scale_200 = 'CAPTURED'; width = $width; height = $height; output = $OutputPath } | ConvertTo-Json -Compress
} finally {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousScale
  if ($client -and -not $client.HasExited) { Stop-Process -Id $client.Id -Force }
  if ($agent -and -not $agent.HasExited) { Stop-Process -Id $agent.Id -Force }
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
