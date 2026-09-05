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

if not "%1"=="" (
    echo Launching Dedicated WhatsApp Bot Agent for %1...
    node whatsapp_bot.js --college %1
    pause
    goto :eof
)

echo Select Mode:
echo [1] Start WhatsApp Bot (Normal Mode)
echo [2] Start WhatsApp Bot (Quiet Mode - No Chat Logs)
echo [3] Reset WhatsApp Login (Scan New QR Code)
echo [4] Start Dedicated Bot for a College
echo.
set /p CHOICE="Enter choice (1-4, press Enter for default 1): "

if "%CHOICE%"=="2" (
    echo Launching in Quiet Mode...
    node whatsapp_bot.js --quiet
) else if "%CHOICE%"=="3" (
    echo Resetting WhatsApp Login...
    node whatsapp_bot.js --reset-login
) else if "%CHOICE%"=="4" (
    set /p COL="Enter College Code (e.g. KLU, VIGNAN, CBIT): "
    node whatsapp_bot.js --college %COL%
) else (
    echo Launching WhatsApp Bot Agent...
    node whatsapp_bot.js
)
pause
