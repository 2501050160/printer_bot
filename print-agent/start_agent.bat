@echo off
title Cloud Print Kiosk - Print Agent
echo ===================================================
echo     Starting Cloud Print Kiosk - Print Agent
echo ===================================================
echo.
cd /d "%~dp0"
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)
echo Launching Print Agent...
npm start
pause
