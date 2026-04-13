# Re-run DNS CNAME creation (uses this folder's config.yml so the correct tunnel is targeted).
param(
    [string] $TunnelId,
    [string] $FrontendHost = "",
    [string] $BackendHost = ""
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_env.ps1"

$localCert = Join-Path $Script:CloudflaredHome "cert.pem"
if (-not (Test-Path $localCert)) {
    Write-Error "Missing cert. Run .\login.ps1 first."
}

if (-not $TunnelId -and (Test-Path $Script:TunnelState)) {
    $st = Get-Content -LiteralPath $Script:TunnelState -Raw | ConvertFrom-Json
    $TunnelId = $st.tunnelId
    if ([string]::IsNullOrWhiteSpace($FrontendHost) -and $st.frontendHost) { $FrontendHost = $st.frontendHost }
    if ([string]::IsNullOrWhiteSpace($BackendHost) -and $st.backendHost) { $BackendHost = $st.backendHost }
}

if (-not $TunnelId) {
    Write-Error "Pass -TunnelId '<uuid>' or run .\bootstrap.ps1 first (creates tunnel-state.json)."
}

if ([string]::IsNullOrWhiteSpace($FrontendHost) -or [string]::IsNullOrWhiteSpace($BackendHost)) {
    Write-Error "Pass -FrontendHost and -BackendHost or run .\bootstrap.ps1 so tunnel-state.json contains them."
}

if (-not (Test-Path $Script:CloudflaredConfig)) {
    Write-Error "Missing config.yml. Run .\bootstrap.ps1 first."
}

& $CloudflaredExe tunnel --config $Script:CloudflaredConfig route dns -f $TunnelId $FrontendHost
& $CloudflaredExe tunnel --config $Script:CloudflaredConfig route dns -f $TunnelId $BackendHost
