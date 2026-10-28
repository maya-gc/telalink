@echo off
REM ==================================================================
REM  TelaLink - inicializador para Windows
REM  Reabre a si mesmo com "cmd /k" para a janela NUNCA fechar sozinha.
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

where node >nul 2>nul
if errorlevel 1 goto :sem_node
if not exist "%~dp0src\server.js" goto :sem_arquivos

echo   [1/2] Autoteste rapido...
node "%~dp0scripts\selfcheck.js"
if errorlevel 1 goto :falha_teste

echo.
echo   [2/2] Abrindo o TelaLink no navegador...
echo         Se nao abrir, acesse:  http://localhost:8080
echo.
echo   O link externo e preparado sozinho, sem instalar nada.
echo   IMPORTANTE: mantenha esta janela aberta enquanto transmite.
echo.
node "%~dp0src\server.js"
echo.
echo   O servidor foi encerrado. Pode fechar esta janela.
goto :eof

:sem_node
echo   [ERRO] Node.js nao encontrado neste computador.
echo.
echo   Instale a versao LTS (gratis, so uma vez) em:  https://nodejs.org
echo   Ou pelo winget:  winget install --id OpenJS.NodeJS.LTS -e
echo   Depois feche esta janela e rode o Iniciar.bat de novo.
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
