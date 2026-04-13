# PS LAUNCHER

Windows **EXE** that runs a **step-by-step installation** once, then opens the **POS webpage** directly on every later launch. Uses **`pos_logo.png`** (splash) and **`pos_icon.ico`** (taskbar / window). **Modern plain light** UI (teal / sky / mint accents).

## Behavior

### First run — installation (step by step)

| Step | What you see |
|------|----------------|
| **1 — Splash & device** | **Logo**, **device name** (hostname), **device IP**, and the **POS URL** (default `https://pos.rfoodinternational.com`) with query params preview. |
| **2 — Finalize** | Same details + full open URL. **Finish & open website** saves config and opens the browser. |

During installation you always see **name**, **IP**, and **URL** so you can verify the PC before going live.

### After installation

- Double-clicking **PS LAUNCHER** opens the POS **immediately** in the default browser (no wizard).
- The browser URL includes `?systemName=...&ip=...`. The POS app stores these in **sessionStorage** so **Counter Setup** (`counter-setup-form`) shows **System name** and **IP** automatically.

- **System name** — Windows computer name (`socket.gethostname()`).
- **Device IP** — Typical LAN IPv4 (via UDP route trick).
- **Default base URL** — `https://pos.rfoodinternational.com` (local dev: `http://<LAN-IP>:7117`; change in `ps_launcher_data/config.json` next to the exe if needed).

## Build the exe

Place **pos_icon.ico** and **pos_logo.png** in the `launcher` folder, then:

```bat
cd launcher
build_ps_launcher.bat
```

Output: `dist\PS LAUNCHER.exe`

Or with PyInstaller directly:

```bat
pyinstaller --noconfirm PS_LAUNCHER.spec
```

## Run without building

```bash
cd launcher
pip install -r requirements.txt
python ps_launcher_app.py
```

## Requirements

- **Python 3** (with tkinter – usually included).
- **Pillow** (for logo image on splash).

## Assets

- **pos_icon.ico** – Application and window icon.
- **pos_logo.png** – Splash screen logo (Step 1).

## Config

After setup, config is stored in `ps_launcher_data/config.json` next to the exe (`installed`, `deviceName`, `deviceIp`, `baseUrl`). Deleting this folder or setting `installed` to false will show the installer again.

---

## Windows “Smart App Control” / SmartScreen — “unsafe” warning

Unsigned `.exe` files (typical for internal PyInstaller builds) are often treated as **unrecognized**. Windows may show **Smart App Control** or **Microsoft Defender SmartScreen** (“Windows protected your PC” / “This app might be unsafe”).

**That warning does not mean the launcher is malicious** — it means Windows has **no reputation** for this file and it is **not signed** with a commercial **code signing certificate**.

### For end users (one-time allow)

1. If you see **“Windows protected your PC”**: click **More info** → **Run anyway**.
2. If **Smart App Control** blocks the app: **Settings** → **Privacy & security** → **Windows Security** → **App & browser control** → **Smart App Control** — your org may set this to **Off** only if policy allows (IT decision).
3. Alternatively: **SmartScreen** / reputation settings under the same **App & browser control** area — adjust only per company policy.

### Proper fix for distribution (developers / IT)

- **Sign the exe** with an **Authenticode** certificate from a trusted CA (e.g. DigiCert, Sectigo). After signing, warnings usually drop as **reputation** builds.
- Optional: submit the file to Microsoft as a false positive if SmartScreen still complains after signing.

The build embeds **File version** / **Product name** via `file_version_info.txt` (right-click exe → **Properties** → **Details**). That helps identification but **does not replace** signing.

Edit `file_version_info.txt` (company name, version) before rebuilding if you want custom metadata.
