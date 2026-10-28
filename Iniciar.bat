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

echo   [1/3] Autoteste rapido...
node "%~dp0scripts\selfcheck.js"
if errorlevel 1 goto :falha_teste

echo.
echo   [2/3] Verificando o link externo (cloudflared oficial)...
if "%TUNNEL%"=="0" goto :iniciar
node "%~dp0scripts\cloudflared-status.js"
if errorlevel 4 goto :assinatura_ruim
if errorlevel 3 goto :oferecer_instalacao
goto :iniciar

:oferecer_instalacao
echo.
echo   Para gerar o link externo, o TelaLink usa o cloudflared, programa
echo   oficial e assinado digitalmente pela Cloudflare. Ele ainda nao esta
echo   instalado. A instalacao e feita pelo winget, o instalador oficial
echo   da Microsoft, e so precisa acontecer uma vez.
echo.
choice /c SN /m "   Instalar o cloudflared agora"
if errorlevel 2 goto :sem_link
where winget >nul 2>nul
if errorlevel 1 goto :sem_winget
winget install --id Cloudflare.cloudflared -e --source winget --accept-source-agreements --accept-package-agreements
node "%~dp0scripts\cloudflared-status.js"
if errorlevel 3 goto :instalacao_falhou
goto :iniciar

:assinatura_ruim
echo.
echo   O cloudflared encontrado NAO tem a assinatura digital da Cloudflare,
echo   entao nao sera usado. Reinstale pelo comando:
echo       winget install --id Cloudflare.cloudflared -e
goto :sem_link

:sem_winget
echo.
echo   O winget nao esta disponivel neste Windows. Instale o aplicativo
echo   "Instalador de Aplicativo" pela Microsoft Store e rode de novo.
goto :sem_link

:instalacao_falhou
echo.
echo   A instalacao nao foi concluida. Feche esta janela e tente de novo.
goto :sem_link

:sem_link
echo.
echo   Seguindo SEM link externo: so funciona neste computador e na sua rede.
set TUNNEL=0

:iniciar
echo.
echo   [3/3] Iniciando. O navegador abre sozinho no painel.
echo         Se nao abrir, acesse:  http://localhost:8080
echo.
echo   O LINK EXTERNO aparece aqui e no painel em alguns segundos.
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
