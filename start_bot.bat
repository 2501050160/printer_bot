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

echo Starting WhatsApp Bot Agent...
if "%~1"=="" (
    node whatsapp_bot.js
) else (
    node whatsapp_bot.js %*
)
pause
