@echo off
setlocal
set "TEMP=%~dp0.runtime\temp"
set "TMP=%TEMP%"
set "npm_config_cache=%~dp0.runtime\npm-cache"
if not exist "%TEMP%" mkdir "%TEMP%"
pushd "%~dp0node-red"
where node.exe >nul 2>nul
if errorlevel 1 goto semnode
echo Instalando Node-RED e Dashboard nesta pasta. Aguarde alguns minutos.
call npm.cmd install --no-audit --no-fund 
if errorlevel 1 goto falha
echo.
echo Instalacao concluida. Agora abra 2_INICIAR_PAINEL.cmd.
popd
pause
exit /b 0
:semnode
echo Node.js nao encontrado. Instale Node.js 24 LTS e tente novamente.
goto fim
:falha
echo Falha na instalacao. Confira a internet e a mensagem acima.
:fim
popd
pause
exit /b 1
