"""
POS Launcher: fetches system name and IP, opens the POS web app with those values
so the app can store them in sessionStorage.
"""
import socket
import webbrowser
import urllib.parse
import sys
import os

# Default URL of the POS web app (change if you deploy elsewhere)
DEFAULT_APP_URL = "http://localhost:5173"


def get_system_name():
    """Return the computer / host name."""
    try:
        return socket.gethostname() or "UNKNOWN"
    except Exception:
        return "UNKNOWN"


def get_local_ip():
    """Return the local (LAN) IP address of this machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        pass
    try:
        return socket.gethostbyname(socket.gethostname()) or "127.0.0.1"
    except Exception:
        return "127.0.0.1"


def main():
    base_url = os.environ.get("POS_APP_URL", DEFAULT_APP_URL).rstrip("/")
    system_name = get_system_name()
    ip = get_local_ip()

    params = {
        "systemName": system_name,
        "ip": ip,
    }
    query = urllib.parse.urlencode(params)
    url = f"{base_url}/?{query}"

    try:
        webbrowser.open(url)
    except Exception as e:
        print(f"Could not open browser: {e}")
        print(f"Open this URL manually: {url}")
        sys.exit(1)


if __name__ == "__main__":
    main()
