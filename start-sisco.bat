@echo off
title SISCO server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org , install it, then double-click this file again.
  pause
  exit /b
)
cd /d "%~dp0"
node server.js
pause
