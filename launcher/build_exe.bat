@echo off
REM Build POS Launcher exe. Run from launcher folder: build_exe.bat
python -m pip install pyinstaller --quiet
pyinstaller --onefile --name POSLauncher --clean pos_launcher.py
echo.
echo Exe created: dist\POSLauncher.exe
pause
