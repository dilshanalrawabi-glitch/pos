@echo off
cd /d "%~dp0"
echo Building PS LAUNCHER...
echo.
if not exist pos_icon.ico (
    echo WARNING: pos_icon.ico not found. Place it in the launcher folder for the app icon.
)
if not exist pos_logo.png (
    echo WARNING: pos_logo.png not found. Place it in the launcher folder for the splash screen.
)
echo.
pyinstaller --noconfirm PS_LAUNCHER.spec
if %ERRORLEVEL% equ 0 (
    echo.
    echo Done. Output: dist\PS LAUNCHER.exe
) else (
    echo.
    echo Build failed.
    exit /b 1
)
