# Full local setup: ensure cert.pem lives under .cloudflared\, then tunnel + config.yml + DNS.
# Browser required the first time: logs into the Cloudflare account that owns your DNS zone (any domain).
# Optional: copy dns-config.example.ps1 -> dns-config.ps1 with your FQDNs, or pass -FrontendHost / -BackendHost to bootstrap.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

. "$PSScriptRoot\_env.ps1"
$localCert = Join-Path $Script:CloudflaredHome "cert.pem"
if (-not (Test-Path $localCert)) {
    Write-Host "Step 1/2: Cloudflare login (cert only under .cloudflared\ here; use the account where your zone lives)"
    & "$PSScriptRoot\login.ps1"
}
if (-not (Test-Path $localCert)) {
    throw "cert.pem still missing under .cloudflared\. Finish browser login and run .\login.ps1 again."
}

Write-Host "Step 2/2: Tunnel, config.yml, DNS"
& "$PSScriptRoot\bootstrap.ps1" @args
