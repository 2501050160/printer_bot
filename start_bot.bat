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

if "%1"=="" (
    echo Launching WhatsApp Bot Agent...
    node whatsapp_bot.js
) else (
    echo Launching Dedicated WhatsApp Bot Agent for %1...
    node whatsapp_bot.js --college %1
)
pause

