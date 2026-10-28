@echo off
if /i not "%~1"=="__run" (
  cmd /k ""%~f0" __run"
  exit /b
)
title Diagnostico - TelaLink
cd /d "%~dp0"

echo.
echo   ================================================
echo     DIAGNOSTICO - TelaLink
echo   ================================================
echo.
echo   Pasta atual: %~dp0
echo.

echo   [1] Node.js instalado?
where node >nul 2>nul
if errorlevel 1 goto :sem_node
for /f "delims=" %%v in ('node --version') do echo       SIM, versao %%v
echo.

echo   [2] Arquivos do programa:
for %%f in (src\server.js src\ws-lite.js src\tunnel.js src\settings.js src\turn.js public\host.html public\viewer.html public\host.js public\viewer.js public\crypto.js public\relay.js scripts\selfcheck.js) do (
  if exist "%~dp0%%f" (echo       OK        %%f) else (echo       FALTANDO  %%f)
)
echo.

echo   [3] Porta 8080:
netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul 2>nul
if errorlevel 1 (echo       Livre) else (echo       OCUPADA - feche outra copia do programa)
echo.

echo   [4] Link externo (cloudflared):
node "%~dp0scripts\cloudflared-status.js"
if errorlevel 4 (echo       Assinatura digital NAO confere - nao sera usado) else if errorlevel 3 (echo       Nao instalado - o Iniciar.bat oferece a instalacao)
echo.

echo   [5] Autoteste do servidor:
node "%~dp0scripts\selfcheck.js"
echo.
echo   ================================================
echo   Tire um print desta janela se precisar de ajuda.
echo   ================================================
goto :eof

:sem_node
echo       NAO - instale em https://nodejs.org
goto :eof
