@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]
REM
REM To skip auto-detection, set TV_EXE before running:
REM   set TV_EXE=C:\path\to\TradingView.exe
REM   scripts\launch_tv_debug.bat

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
REM Use ping instead of timeout — timeout fails when stdin isn't a console
ping -n 3 127.0.0.1 >nul

REM Allow caller to supply the path via environment variable
if not "%TV_EXE%"=="" goto :launch

REM Auto-detect TradingView install location
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps
    echo.
    echo Set the TV_EXE environment variable to your TradingView.exe path, e.g.:
    echo   set TV_EXE=C:\Users\micha\AppData\Local\TradingView\TradingView.exe
    echo   npm run dashboard
    echo.
    echo Or run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

:launch
echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    ping -n 3 127.0.0.1 >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
