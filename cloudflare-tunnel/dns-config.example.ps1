# Copy to dns-config.ps1 in this folder (dns-config.ps1 is gitignored).
# Use FQDNs that exist in the Cloudflare zone you log into with .\login.ps1
# (can be a different domain than rfoodinternational.com).

$DefaultFrontendHost = "pos.your-domain.com"
$DefaultBackendHost = "pos-backend.your-domain.com"
