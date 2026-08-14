@echo off
title Xero's Store Bot - Auto Restart
echo ==========================================
echo   XERO'S STORE BOT - ALWAYS ONLINE
echo   (Auto-restarts if it crashes)
echo   Close this window to STOP the bot
echo ==========================================
echo.
:loop
echo [%date% %time%] Starting bot...
node index.js
echo.
echo [!] Bot stopped/crashed - restarting in 5 seconds...
timeout /t 5 /nobreak > nul
goto loop
