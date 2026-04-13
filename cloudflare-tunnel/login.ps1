# Cloudflare browser login for THIS repo only. New cert is saved under cloudflare-tunnel\.cloudflared\cert.pem
# Does NOT replace C:\Users\...\ .cloudflared\cert.pem (your other projects keep their login cert).
#
# cloudflared always writes login to %USERPROFILE%\.cloudflared\cert.pem, so we:
#   rename existing profile cert aside -> login -> copy new cert to project -> delete new profile cert -> restore rename.
. "$PSScriptRoot\_env.ps1"

$userDir = Join-Path $env:USERPROFILE ".cloudflared"
$userCert = Join-Path $userDir "cert.pem"
$projectCert = Join-Path $Script:CloudflaredHome "cert.pem"
$preservedName = "cert.pem.__pos_wholesale_login_preserved__"
$preservedPath = Join-Path $userDir $preservedName

New-Item -ItemType Directory -Force -Path $userDir | Out-Null
New-Item -ItemType Directory -Force -Path $Script:CloudflaredHome | Out-Null

$hadProfileCert = Test-Path -LiteralPath $userCert
if ($hadProfileCert) {
    if (Test-Path -LiteralPath $preservedPath) { Remove-Item -LiteralPath $preservedPath -Force }
    Rename-Item -LiteralPath $userCert -NewName $preservedName
    Write-Host "Temporarily moved your profile cert aside (will restore after login): $userCert"
}

try {
    Write-Host "Complete login in the browser when it opens..."
    & $CloudflaredExe tunnel login
    if ($LASTEXITCODE -ne 0) {
        throw "cloudflared tunnel login exited with code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $userCert)) {
        throw "Expected new cert at $userCert after login. Finish the browser flow and try again."
    }
    Copy-Item -LiteralPath $userCert -Destination $projectCert -Force
    Write-Host "Saved project cert: $projectCert"
    Remove-Item -LiteralPath $userCert -Force
}
finally {
    if ($hadProfileCert) {
        if (Test-Path -LiteralPath $userCert) { Remove-Item -LiteralPath $userCert -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $preservedPath) {
            Rename-Item -LiteralPath $preservedPath -NewName "cert.pem"
            Write-Host "Restored your original profile cert (other projects unchanged): $userCert"
        }
    }
}

if (Test-Path -LiteralPath $projectCert) {
    $env:TUNNEL_ORIGIN_CERT = $projectCert
}
