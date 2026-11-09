@echo off
setlocal
set "TEMP=%~dp0.runtime\temp"
set "TMP=%TEMP%"
set "npm_config_cache=%~dp0.runtime\npm-cache"
if not exist "%TEMP%" mkdir "%TEMP%"
pushd "%~dp0node-red"
if not exist "node_modules\node-red\red.js" goto instalar
echo Mantenha esta janela aberta enquanto usa o painel.
echo Aguarde a mensagem Server now running.
echo Editor: http://localhost:1880
echo Painel: http://localhost:1880/ui
node "node_modules\node-red\red.js" --userDir "." --settings "settings.js" "flows.json"
popd
pause
exit /b 0
:instalar
echo Execute primeiro 1_INSTALAR_PAINEL.cmd.
popd
pause
exit /b 1
