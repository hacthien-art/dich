@echo off
chcp 65001 >nul
title Tavern Card Translator
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Hay tai ban LTS tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)
node server.js %*
pause
