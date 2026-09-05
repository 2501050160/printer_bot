@echo off
title Cloud Print Kiosk - Reset WhatsApp Bot Login
echo ========================================================
echo   Cloud Print Kiosk - Reset WhatsApp Login Session
echo ========================================================
echo.
cd /d "%~dp0"

echo Removing WhatsApp session credentials...
if exist .baileys_auth (
    rmdir /s /q .baileys_auth
    echo [OK] Removed unified bot session (.baileys_auth).
)
for /d %%i in (.baileys_auth_*) do (
    rmdir /s /q "%%i"
    echo [OK] Removed college bot session (%%i).
)

echo.
echo ========================================================
echo   [SUCCESS] Login credentials removed successfully!
echo   When you start the bot next, a new QR code will appear.
echo ========================================================
echo.
pause
