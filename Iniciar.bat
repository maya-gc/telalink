@echo off
REM ==================================================================
REM  TelaLink - inicializador para Windows
REM  Reabre a si mesmo com "cmd /k" para a janela NUNCA fechar sozinha.
REM  Na primeira vez, baixa sozinho o que falta (Node.js e cloudflared
REM  oficiais, conferidos por SHA-256 e assinatura digital) para a pasta
REM  .runtime - nada e instalado no Windows e nao pede administrador.
REM ==================================================================
if /i not "%~1"=="__run" (
  cmd /k ""%~f0" __run"
  exit /b
)

title TelaLink
cd /d "%~dp0"

echo.
echo   ================================================
echo     TelaLink - compartilhamento de tela seguro
echo   ================================================
echo.
if not exist "%~dp0src\server.js" goto :sem_arquivos

echo   [1/3] Preparando o que o TelaLink precisa...
set "TL_NODE="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar-node.ps1"
if not errorlevel 1 if exist "%~dp0.runtime\node-path.txt" set /p TL_NODE=<"%~dp0.runtime\node-path.txt"
if not defined TL_NODE for /f "delims=" %%n in ('where node 2^>nul') do if not defined TL_NODE set "TL_NODE=%%n"
if not defined TL_NODE goto :sem_node
"%TL_NODE%" "%~dp0scripts\baixar-cloudflared.js"

echo.
echo   [2/3] Autoteste rapido...
"%TL_NODE%" "%~dp0scripts\selfcheck.js"
if errorlevel 1 goto :falha_teste

echo.
echo   [3/3] Abrindo o TelaLink no navegador...
echo         Se nao abrir, acesse:  http://localhost:8080
echo.
echo   IMPORTANTE: mantenha esta janela aberta enquanto transmite.
echo.
"%TL_NODE%" "%~dp0src\server.js"
echo.
echo   O servidor foi encerrado. Pode fechar esta janela.
goto :eof

:sem_node
echo.
echo   [ERRO] Nao foi possivel preparar o Node.js.
echo   Verifique a internet e rode o Iniciar.bat de novo.
echo   Ou instale manualmente a versao LTS em:  https://nodejs.org
goto :eof

:sem_arquivos
echo   [ERRO] Arquivos do programa nao encontrados nesta pasta.
echo   Se voce abriu de dentro de um .zip, extraia primeiro.
goto :eof

:falha_teste
echo.
echo   [ERRO] O autoteste falhou. Veja a mensagem acima.
echo   Rode o Diagnostico.bat e mande um print da janela.
goto :eof
