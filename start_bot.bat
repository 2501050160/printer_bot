@echo off
title Cloud Print Kiosk - WhatsApp Bot Agent
echo ===================================================
echo   Starting Cloud Print Kiosk - WhatsApp Bot Agent
echo ===================================================
echo.
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)
echo Launching WhatsApp Bot Agent (Render Backend)...
npm start
pause

