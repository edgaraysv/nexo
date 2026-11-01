!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Instalando servicio NEXO Endpoint..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\install-l07-service.ps1" -AgentPath "$INSTDIR\resources\nexo-agent.exe" -AgentUpdaterPath "$INSTDIR\resources\nexo-agent-updater.exe" -ApiBase "http://127.0.0.1:3000"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo instalar el servicio NEXO Endpoint (código $0)."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Retirando servicio NEXO Endpoint y conservando su identidad..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-l07-service.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo retirar el servicio NEXO Endpoint (código $0)."
    Abort
  ${EndIf}
!macroend
