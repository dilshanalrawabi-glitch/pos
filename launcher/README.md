# POS Launcher (exe)

This launcher gets the **system (computer) name** and **local IP address**, then opens the POS web app in the default browser and passes those values in the URL. The web app stores them in **sessionStorage** (`pos_system_name`, `pos_system_ip`).

## Run without building exe

```bash
cd launcher
python pos_launcher.py
```

## Build exe

1. Open a terminal in the `launcher` folder.
2. Run:
   ```bash
   build_exe.bat
   ```
   Or manually:
   ```bash
   python -m pip install pyinstaller
   pyinstaller --onefile --name POSLauncher --clean pos_launcher.py
   ```
3. The executable is created at `launcher\dist\POSLauncher.exe`.

## Change the web app URL

- Default: `http://localhost:5173`
- Set environment variable before running:
  ```bash
  set POS_APP_URL=http://192.168.1.100:5173
  python pos_launcher.py
  ```
- For the exe, set `POS_APP_URL` in the environment where you run `POSLauncher.exe`, or edit `DEFAULT_APP_URL` in `pos_launcher.py` and rebuild.

## In the web app

- **sessionStorage** keys: `pos_system_name`, `pos_system_ip`
- Read them anywhere: `sessionStorage.getItem('pos_system_name')`, `sessionStorage.getItem('pos_system_ip')`
