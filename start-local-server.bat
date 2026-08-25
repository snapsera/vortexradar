@echo off
setlocal
cd /d "%~dp0"

set "PORT=9191"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 18 or newer, then try again.
    pause
    exit /b 1
)

if not exist "node_modules\express\package.json" (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo npm was not found. Reinstall Node.js, then try again.
        pause
        exit /b 1
    )

    echo Installing project dependencies for the first launch...
    call npm install
    if errorlevel 1 (
        echo.
        echo Dependency installation failed.
        pause
        exit /b 1
    )
    echo.
)

echo Starting Vortex Radar at http://localhost:%PORT%
echo Close this window or press Ctrl+C to stop the server.
echo.

node server.js
set "SERVER_EXIT_CODE=%ERRORLEVEL%"

if not "%SERVER_EXIT_CODE%"=="0" (
    echo.
    echo The server stopped with exit code %SERVER_EXIT_CODE%.
    pause
)

exit /b %SERVER_EXIT_CODE%
