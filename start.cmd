@echo off
rem Start the Snake server and open it in the browser
cd /d "%~dp0"
start "Snake server" cmd /k "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5178"
