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

echo   [1] Node.js:
set "TL_NODE="
if exist "%~dp0.runtime\node-path.txt" set /p TL_NODE=<"%~dp0.runtime\node-path.txt"
if not defined TL_NODE for /f "delims=" %%n in ('where node 2^>nul') do if not defined TL_NODE set "TL_NODE=%%n"
if not defined TL_NODE goto :sem_node
for /f "delims=" %%v in ('"%TL_NODE%" --version') do echo       OK, versao %%v em %TL_NODE%
echo.

echo   [2] Arquivos do programa:
for %%f in (src\server.js src\ws-lite.js src\tunnel.js src\settings.js src\turn.js src\tunnel-manager.js src\sistema.js public\host.html public\viewer.html public\host.js public\viewer.js public\crypto.js public\relay.js public\output.js public\media-util.js scripts\selfcheck.js scripts\instalar-node.ps1 scripts\baixar-cloudflared.js) do (
  if exist "%~dp0%%f" (echo       OK        %%f) else (echo       FALTANDO  %%f)
)
echo.

echo   [3] Porta 8080:
netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul 2>nul
if errorlevel 1 (echo       Livre) else (echo       OCUPADA - feche outra copia do programa)
echo.

echo   [4] Link externo (Cloudflare):
"%TL_NODE%" "%~dp0scripts\cloudflared-status.js"
if errorlevel 4 (echo       Assinatura digital NAO confere - nao sera usado) else if errorlevel 3 (echo       Nao encontrado - o Iniciar.bat baixa sozinho (ou usa o SSH do Windows))
echo.

echo   [5] Autoteste do servidor:
"%TL_NODE%" "%~dp0scripts\selfcheck.js"
echo.
echo   ================================================
echo   Tire um print desta janela se precisar de ajuda.
echo   ================================================
goto :eof

:sem_node
echo       NAO - rode o Iniciar.bat (ele baixa sozinho) ou instale em https://nodejs.org
goto :eof
