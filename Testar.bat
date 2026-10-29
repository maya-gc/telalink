@echo off
if /i not "%~1"=="__run" (
  cmd /k ""%~f0" __run"
  exit /b
)
title Testes - TelaLink
cd /d "%~dp0"

set "TL_NODE="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar-node.ps1"
if not errorlevel 1 if exist "%~dp0.runtime\node-path.txt" set /p TL_NODE=<"%~dp0.runtime\node-path.txt"
if not defined TL_NODE for /f "delims=" %%n in ('where node 2^>nul') do if not defined TL_NODE set "TL_NODE=%%n"
if not defined TL_NODE goto :sem_node

echo.
echo   Rodando a bateria de testes automaticos...
echo   (os testes com navegador real rodam se o Playwright estiver instalado)
echo.
"%TL_NODE%" --test --test-concurrency=1 --test-reporter=spec "test/*.test.js"
if errorlevel 1 goto :falhou

echo.
echo   ================================================
echo     TODOS OS TESTES PASSARAM
echo   ================================================
goto :eof

:falhou
echo.
echo   ================================================
echo     ALGUM TESTE FALHOU - veja os detalhes acima
echo   ================================================
goto :eof

:sem_node
echo   [ERRO] Node.js nao encontrado. Rode o Iniciar.bat primeiro.
goto :eof
