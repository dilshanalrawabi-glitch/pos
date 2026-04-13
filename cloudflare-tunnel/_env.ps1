# Project-local Cloudflare Tunnel: all credentials and config stay under this folder only.
$Script:CloudflaredTunnelRoot = $PSScriptRoot
$Script:CloudflaredHome = Join-Path $PSScriptRoot ".cloudflared"
$Script:CloudflaredConfig = Join-Path $PSScriptRoot "config.yml"
$Script:TunnelState = Join-Path $PSScriptRoot "tunnel-state.json"

New-Item -ItemType Directory -Force -Path $Script:CloudflaredHome | Out-Null

# Do not set CLOUDFLARED_HOME here: cloudflared tunnel login always uses %USERPROFILE%\.cloudflared\;
# we isolate this project via TUNNEL_ORIGIN_CERT + scripts in login.ps1.

$__cert = Join-Path $Script:CloudflaredHome "cert.pem"
if (Test-Path $__cert) {
    $env:TUNNEL_ORIGIN_CERT = $__cert
}

$found = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($found) {
    $Script:CloudflaredExe = $found.Source
} else {
    $bundled = Join-Path $PSScriptRoot "bin\cloudflared.exe"
    if (Test-Path -LiteralPath $bundled) {
        $Script:CloudflaredExe = $bundled
    } else {
        $Script:CloudflaredExe = "cloudflared"
    }
}
