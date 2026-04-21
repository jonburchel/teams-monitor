@echo off
REM One-time auth for Teams, Mail, Calendar MCPs + Graph Chat API
REM Run this once before starting the monitor loop.
REM It will open browser windows for sign-in.

cd /d "%~dp0"
echo ============================================
echo  Teams Monitor - One-Time MCP Authentication
echo ============================================
echo.
echo This will sign you in to:
echo   - Microsoft Teams, Mail, Calendar (via Agency MCPs)
echo   - Microsoft Graph Chat API (for mark-unread)
echo.

echo --- Step 1: Agency MCP Auth ---
echo After signing in, the browser windows will close automatically.
echo.

agency copilot --no-default-mcps --mcp teams --mcp mail --mcp calendar -- -s

echo.
echo --- Step 2: Graph Chat Auth (mark-unread) ---
echo.

node teams-bridge\auth-graph.mjs

echo.
echo ============================================
echo  Authentication complete! Run: start-agents.ps1
echo ============================================
pause
