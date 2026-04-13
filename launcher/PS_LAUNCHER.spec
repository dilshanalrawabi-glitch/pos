# -*- mode: python ; coding: utf-8 -*-
# PS LAUNCHER - step-by-step installer then direct webpage launch

import os

block_cipher = None

# Assets bundled into exe (extracted to _MEIPASS at runtime)
launcher_dir = os.path.dirname(os.path.abspath(SPEC))
assets = []
for name in ('pos_logo.png', 'pos_icon.ico'):
    path = os.path.join(launcher_dir, name)
    if os.path.exists(path):
        assets.append((path, '.'))

_version_info = os.path.join(launcher_dir, 'file_version_info.txt')

a = Analysis(
    ['ps_launcher_app.py'],
    pathex=[launcher_dir],
    binaries=[],
    datas=assets,
    hiddenimports=['PIL._tkinter_finder'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='PS LAUNCHER',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX compression can increase “unknown app” / AV heuristic warnings — keep off for launcher
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(launcher_dir, 'pos_icon.ico') if os.path.exists(os.path.join(launcher_dir, 'pos_icon.ico')) else None,
    version=os.path.join(launcher_dir, 'file_version_info.txt') if os.path.exists(_version_info) else None,
)
