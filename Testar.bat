@echo off
if /i not "%~1"=="__run" (
  cmd /k ""%~f0" __run"
  exit /b
)
title Testes - TelaLink
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :sem_node

echo.
echo   Rodando a bateria de testes automaticos...
echo   (os testes com navegador real rodam se o Playwright estiver instalado)
echo.
node --test --test-reporter=spec "test/*.test.js"
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
echo   [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
goto :eof
