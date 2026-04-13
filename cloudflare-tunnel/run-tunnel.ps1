# Runs the tunnel using project-local config.yml (ingress -> localhost:7117 and :7227).
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_env.ps1"

if (-not (Test-Path $Script:CloudflaredConfig)) {
    Write-Error "Missing config.yml. Run .\bootstrap.ps1 first."
}

$localCert = Join-Path $Script:CloudflaredHome "cert.pem"
if (-not (Test-Path $localCert)) {
    Write-Error "Missing cert.pem in .cloudflared\. Run .\login.ps1 first."
}

& $CloudflaredExe tunnel --config $Script:CloudflaredConfig run
