# build-deploy.ps1 — cross-compile for Linux and deploy to pal via ssh
# Usage: .\deploy\build-deploy.ps1

$ErrorActionPreference = 'Stop'

$env:GOOS        = 'linux'
$env:GOARCH      = 'amd64'
$env:CGO_ENABLED = '0'

Write-Host "Building..."
New-Item -ItemType Directory -Force -Path out | Out-Null
go build -trimpath -ldflags '-s -w' -o out/screenshare .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Deploying to pal..."
# Upload as .new to avoid ETXTBSY on the running binary
scp out/screenshare pal:share/screenshare.new
ssh pal 'mv share/screenshare.new share/screenshare && chmod +x share/screenshare && pkill -x screenshare || true'

Write-Host "Done. systemd will restart the service automatically."
