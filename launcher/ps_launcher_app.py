"""
PS LAUNCHER — Step 1: splash + device name, IP, URL. Step 2: confirm & open POS site.
Uses pos_logo.png and pos_icon.ico. Modern plain light theme (logo-inspired teal / sky / mint).
After install, opens the browser directly on every launch.
"""
import sys
import json
import socket
import webbrowser
from urllib.parse import urlencode
import tkinter as tk
from tkinter import font as tkfont
from pathlib import Path

# Default POS frontend (tunnel / production or local Vite). Edit config.json next to exe to change.
DEFAULT_BASE_URL = "https://pos.rfoodinternational.com"

# Modern light palette (aligned with logo: teal, sky blue, mint)
BG = "#f4f7f9"
CARD_BG = "#ffffff"
TEXT = "#0f172a"
TEXT_MUTED = "#64748b"
ACCENT_TEAL = "#0d9488"
ACCENT_TEAL_HOVER = "#0f766e"
ACCENT_SKY = "#0284c7"
STEP_BADGE_BG = "#e0f2fe"
STEP_BADGE_FG = "#0369a1"
MINT_SOFT = "#d1fae5"
MINT_BORDER = "#6ee7b7"
BORDER = "#e2e8f0"


def get_launcher_dir():
    """Directory where the exe or script lives (for config)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def get_assets_dir():
    """Bundled assets (logo, icon). When frozen, PyInstaller extracts to _MEIPASS."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def get_config_path():
    data_dir = get_launcher_dir() / "ps_launcher_data"
    data_dir.mkdir(exist_ok=True)
    return data_dir / "config.json"


def load_config():
    path = get_config_path()
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(config):
    path = get_config_path()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def get_device_name():
    try:
        return socket.gethostname() or "Unknown"
    except Exception:
        return "Unknown"


def get_device_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "Unknown"


class PSLauncherApp:
    def __init__(self):
        self.config = load_config()
        self.base_url = (self.config.get("baseUrl") or DEFAULT_BASE_URL).strip()

        if self.config.get("installed"):
            self._launch_browser(self.config)
            return

        self.root = tk.Tk()
        self.root.title("PS LAUNCHER — Setup")
        self.root.resizable(False, False)
        self.root.configure(bg=BG)

        assets_dir = get_assets_dir()
        icon_path = assets_dir / "pos_icon.ico"
        if icon_path.exists():
            try:
                self.root.iconbitmap(str(icon_path))
            except Exception:
                pass

        self.logo_path = assets_dir / "pos_logo.png"
        self.device_name = ""
        self.device_ip = ""
        self.photo = None

        self.root.geometry("560x580")
        self._center_window()

        self.container = tk.Frame(self.root, bg=BG, padx=28, pady=18)
        self.container.pack(fill=tk.BOTH, expand=True)

        self.step1_frame = tk.Frame(self.container, bg=BG)
        self.step2_frame = tk.Frame(self.container, bg=BG)

        self._build_step1()
        self._build_step2()

        self.step1_frame.pack(fill=tk.BOTH, expand=True)
        self.step2_frame.pack_forget()

        self.root.after(80, self._fetch_device_info)
        self.root.mainloop()

    def _center_window(self):
        self.root.update_idletasks()
        w = self.root.winfo_reqwidth()
        h = self.root.winfo_reqheight()
        x = (self.root.winfo_screenwidth() // 2) - (w // 2)
        y = (self.root.winfo_screenheight() // 2) - (h // 2)
        self.root.geometry(f"+{x}+{y}")

    def _title_font(self):
        return tkfont.Font(family="Segoe UI", size=20, weight="bold")

    def _body_font(self):
        return tkfont.Font(family="Segoe UI", size=10)

    def _btn_primary(self):
        return {
            "font": ("Segoe UI", 10, "bold"),
            "fg": "white",
            "bg": ACCENT_TEAL,
            "activeforeground": "white",
            "activebackground": ACCENT_TEAL_HOVER,
            "relief": tk.FLAT,
            "padx": 22,
            "pady": 10,
            "cursor": "hand2",
        }

    def _btn_secondary(self):
        return {
            "font": ("Segoe UI", 9),
            "fg": TEXT_MUTED,
            "bg": BG,
            "activeforeground": TEXT,
            "activebackground": "#e8eef2",
            "relief": tk.FLAT,
            "padx": 12,
            "pady": 6,
            "cursor": "hand2",
        }

    def _build_step1(self):
        f = self.step1_frame
        badge = tk.Label(
            f,
            text="  Step 1 of 2 — Splash & device  ",
            font=("Segoe UI", 9, "bold"),
            fg=STEP_BADGE_FG,
            bg=STEP_BADGE_BG,
        )
        badge.pack(pady=(0, 6))

        tk.Label(f, text="PS LAUNCHER", font=self._title_font(), fg=TEXT, bg=BG).pack(pady=(0, 4))
        tk.Label(
            f,
            text="Installation: review this PC’s name and IP, the POS URL, then continue to finalize and open the site.",
            font=self._body_font(),
            fg=TEXT_MUTED,
            bg=BG,
            wraplength=480,
            justify=tk.CENTER,
        ).pack(pady=(0, 10))

        self.logo_label_s1 = tk.Label(f, bg=BG)
        self.logo_label_s1.pack(pady=(0, 14))
        self._load_logo_into(self.logo_label_s1)

        card = tk.Frame(f, bg=CARD_BG, relief=tk.FLAT, highlightbackground=BORDER, highlightthickness=1, padx=18, pady=14)
        card.pack(fill=tk.X, pady=4)

        tk.Label(card, text="Device name", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=CARD_BG).pack(anchor=tk.W)
        self.name_var = tk.StringVar(value="Fetching…")
        tk.Label(card, textvariable=self.name_var, font=("Segoe UI", 12), fg=TEXT, bg=CARD_BG).pack(anchor=tk.W, pady=(2, 10))
        tk.Label(card, text="Device IP address", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=CARD_BG).pack(anchor=tk.W)
        self.ip_var = tk.StringVar(value="Fetching…")
        tk.Label(card, textvariable=self.ip_var, font=("Segoe UI", 12), fg=TEXT, bg=CARD_BG).pack(anchor=tk.W, pady=(2, 10))

        url_row = tk.Frame(card, bg=MINT_SOFT, highlightbackground=MINT_BORDER, highlightthickness=1)
        url_row.pack(fill=tk.X, pady=(4, 0))
        tk.Label(url_row, text="POS URL (opens after finalize — Counter Setup reads name & IP)", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=MINT_SOFT).pack(
            anchor=tk.W, padx=10, pady=(8, 0)
        )
        self.url_var_s1 = tk.StringVar(value="")
        tk.Label(
            url_row,
            textvariable=self.url_var_s1,
            font=("Segoe UI", 10),
            fg=ACCENT_TEAL,
            bg=MINT_SOFT,
            wraplength=460,
            justify=tk.LEFT,
        ).pack(anchor=tk.W, padx=10, pady=(2, 10))

        tk.Button(f, text="Next → Step 2", command=self._show_step2, **self._btn_primary()).pack(pady=(18, 6))

    def _build_step2(self):
        f = self.step2_frame
        badge = tk.Label(
            f,
            text="  Step 2 of 2 — Finalize  ",
            font=("Segoe UI", 9, "bold"),
            fg=STEP_BADGE_FG,
            bg=STEP_BADGE_BG,
        )
        badge.pack(pady=(0, 6))

        tk.Label(f, text="Finalize installation", font=self._title_font(), fg=TEXT, bg=BG).pack(pady=(0, 4))
        tk.Label(
            f,
            text="Confirm device name, IP, and URL. Finish to open the POS in your browser.\n"
            "After this, every launch opens the site immediately (no installer).",
            font=self._body_font(),
            fg=TEXT_MUTED,
            bg=BG,
            wraplength=480,
            justify=tk.CENTER,
        ).pack(pady=(0, 12))

        self.logo_label_s2 = tk.Label(f, bg=BG)
        self.logo_label_s2.pack(pady=(0, 10))
        # Logo loaded when step2 shown (reuse photo ref)

        card = tk.Frame(f, bg=CARD_BG, relief=tk.FLAT, highlightbackground=BORDER, highlightthickness=1, padx=18, pady=14)
        card.pack(fill=tk.X, pady=4)

        tk.Label(card, text="Device name", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=CARD_BG).pack(anchor=tk.W)
        self.name_var_s2 = tk.StringVar(value="")
        tk.Label(card, textvariable=self.name_var_s2, font=("Segoe UI", 12), fg=TEXT, bg=CARD_BG).pack(anchor=tk.W, pady=(2, 8))
        tk.Label(card, text="Device IP address", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=CARD_BG).pack(anchor=tk.W)
        self.ip_var_s2 = tk.StringVar(value="")
        tk.Label(card, textvariable=self.ip_var_s2, font=("Segoe UI", 12), fg=TEXT, bg=CARD_BG).pack(anchor=tk.W, pady=(2, 8))

        tk.Label(card, text="Full URL (browser will open with system name & IP for Counter Setup)", font=("Segoe UI", 8, "bold"), fg=TEXT_MUTED, bg=CARD_BG).pack(
            anchor=tk.W, pady=(4, 0)
        )
        self.full_url_var = tk.StringVar(value="")
        tk.Label(
            card,
            textvariable=self.full_url_var,
            font=("Consolas", 9),
            fg=ACCENT_SKY,
            bg=CARD_BG,
            wraplength=460,
            justify=tk.LEFT,
        ).pack(anchor=tk.W, pady=(4, 0))

        btn_row = tk.Frame(f, bg=BG)
        btn_row.pack(pady=(16, 6))
        tk.Button(btn_row, text="← Back", command=self._show_step1, **self._btn_secondary()).pack(side=tk.LEFT, padx=(0, 8))
        tk.Button(
            btn_row,
            text="Finish & open website",
            command=self._finalize_and_open,
            **self._btn_primary(),
        ).pack(side=tk.LEFT)

    def _load_logo_into(self, label):
        if not self.logo_path.exists():
            label.config(text="[Logo: add pos_logo.png]", font=("Segoe UI", 11), fg=TEXT_MUTED)
            return
        try:
            from PIL import Image, ImageTk

            img = Image.open(self.logo_path)
            ratio = min(280 / img.width, 120 / img.height) if img.width and img.height else 1
            if ratio < 1:
                new_w = int(img.width * ratio)
                new_h = int(img.height * ratio)
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
            self.photo = ImageTk.PhotoImage(img)
            label.config(image=self.photo)
        except Exception:
            label.config(text="[Logo]", font=("Segoe UI", 14), fg=TEXT_MUTED)

    def _show_step2(self):
        self.name_var_s2.set(self.name_var.get())
        self.ip_var_s2.set(self.ip_var.get())
        self._sync_urls()
        self.full_url_var.set(self._build_open_url())
        if self.photo:
            self.logo_label_s2.config(image=self.photo)
        else:
            self._load_logo_into(self.logo_label_s2)
        self.step1_frame.pack_forget()
        self.step2_frame.pack(fill=tk.BOTH, expand=True)

    def _show_step1(self):
        self.step2_frame.pack_forget()
        self.step1_frame.pack(fill=tk.BOTH, expand=True)

    def _sync_urls(self):
        self.url_var_s1.set(self._build_open_url())

    def _build_open_url(self):
        base = self.base_url.rstrip("/")
        q = {}
        if self.device_name:
            q["systemName"] = self.device_name
        if self.device_ip:
            q["ip"] = self.device_ip
        return f"{base}/?{urlencode(q)}" if q else f"{base}/"

    def _fetch_device_info(self):
        self.device_name = get_device_name()
        self.device_ip = get_device_ip()
        self.name_var.set(self.device_name)
        self.ip_var.set(self.device_ip)
        self._sync_urls()

    def _finalize_and_open(self):
        self.device_name = self.device_name or get_device_name()
        self.device_ip = self.device_ip or get_device_ip()
        self.config["installed"] = True
        self.config["deviceName"] = self.device_name
        self.config["deviceIp"] = self.device_ip
        self.config["baseUrl"] = self.base_url
        save_config(self.config)
        self._launch_browser(self.config)
        self.root.destroy()

    @staticmethod
    def _launch_browser(cfg):
        base = (cfg.get("baseUrl") or DEFAULT_BASE_URL).rstrip("/")
        name = cfg.get("deviceName") or get_device_name()
        ip = cfg.get("deviceIp") or get_device_ip()
        q = {}
        if name:
            q["systemName"] = name
        if ip:
            q["ip"] = ip
        url = f"{base}/?{urlencode(q)}" if q else f"{base}/"
        webbrowser.open(url)


if __name__ == "__main__":
    PSLauncherApp()
