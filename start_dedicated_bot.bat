@echo off
title Cloud Print Kiosk - Dedicated College WhatsApp Bot
echo ==============================================================
echo   Cloud Print Kiosk - Dedicated College WhatsApp Bot Launcher
echo ==============================================================
echo.
cd /d "%~dp0"

set COLLEGE=%1
if "%COLLEGE%"=="" (
    set /p COLLEGE="Enter College Code for this dedicated bot (e.g. KLU, VIGNAN, SRM): "
)

if "%COLLEGE%"=="" (
    echo No college entered. Launching in Unified Multi-College Mode...
    node whatsapp_bot.js
    pause
    goto :eof
)

echo.
echo ==============================================================
echo   Launching Dedicated WhatsApp Bot for: %COLLEGE%
echo ==============================================================
echo.
node whatsapp_bot.js --college %COLLEGE%
pause
