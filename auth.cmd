@echo off
REM One-time auth for Teams, Mail, Calendar MCPs
REM Run this once before starting the monitor loop.
REM It will open browser windows for sign-in.

cd /d "%~dp0"
echo ============================================
echo  Teams Monitor - One-Time MCP Authentication
echo ============================================
echo.
echo This will open browser windows for sign-in to:
echo   - Microsoft Teams
echo   - Microsoft Mail
echo   - Microsoft Calendar
echo.
echo After signing in, close this window and run: run.ps1
echo.

agency copilot --no-default-mcps --mcp teams --mcp mail --mcp calendar -- -s

