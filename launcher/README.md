# POS Launcher

Opens the POS web app in your browser with **system name** and **IP** in the URL (stored in sessionStorage for Counter Setup).

## How to open / run

### Option 1: Double-click (File Explorer)
- In **File Explorer**, go to your project folder → **launcher**
- Double-click **run_launcher.bat**  
  (Or double-click **pos_launcher.py** if Python is set to run .py files.)

### Option 2: Terminal / CMD
```bash
cd launcher
python pos_launcher.py
```

### Option 3: From project root
```bash
python launcher/pos_launcher.py
```

### In Cursor: Go to File
- Press **Ctrl+P** (or **Ctrl+E**), type `launcher` or `pos_launcher`
- Open **launcher/pos_launcher.py**
- To **run** it: right-click in the editor → **Run Python File in Terminal**, or open the terminal and run:
  ```bash
  python launcher/pos_launcher.py
  ```

## Requirements
- Python 3
- POS frontend running (e.g. `npm run dev` on http://localhost:5173)

To use a different URL set: `POS_APP_URL=http://yourserver:port` before running.
