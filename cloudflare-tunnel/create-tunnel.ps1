# Creates a named tunnel; credentials JSON under cloudflare-tunnel\.cloudflared\ (use bootstrap.ps1 for full setup + DNS).
param(
    [Parameter(Mandatory = $true)]
    [string] $Name
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_env.ps1"

$credPath = Join-Path $Script:CloudflaredHome "tunnel-credentials.json"
& $CloudflaredExe tunnel create --credentials-file $credPath -o json $Name
