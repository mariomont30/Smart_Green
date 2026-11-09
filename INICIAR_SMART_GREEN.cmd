@echo off
setlocal
if /I not "%~d0"=="D:" (
  echo Este projeto foi configurado para executar no disco D.
  pause
  exit /b 1
)
set "TEMP=%~dp0.runtime\temp"
set "TMP=%TEMP%"
set "npm_config_cache=%~dp0.runtime\npm-cache"
if not exist "%TEMP%" mkdir "%TEMP%"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale Node.js 24 LTS antes de continuar.
  pause
  exit /b 1
)
pushd "%~dp0node-red"
if exist "node_modules\node-red\red.js" goto painel_ok
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto falha
:painel_ok
popd
pushd "%~dp0"
if exist ".runtime\tools\node_modules\playwright-core\package.json" goto navegador_ok
call npm.cmd install --prefix ".runtime/tools" --no-audit --no-fund playwright-core
if errorlevel 1 goto falha
:navegador_ok
node ".runtime\iniciar-projeto.cjs"
if errorlevel 1 goto falha
popd
exit /b 0
:falha
echo.
echo A inicializacao falhou. Copie a mensagem acima para conferir o problema.
popd
pause
exit /b 1

