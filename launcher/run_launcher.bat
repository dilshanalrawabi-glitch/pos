@echo off
cd /d "%~dp0"
python pos_launcher.py
if errorlevel 1 pause
