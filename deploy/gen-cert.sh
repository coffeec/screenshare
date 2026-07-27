#!/usr/bin/env bash
# Run once on pal to generate a self-signed cert with SANs for both LAN and public IPs.
# Usage: bash gen-cert.sh <public-ip-or-hostname>
# Example: bash gen-cert.sh 120.85.104.92
# Or with SakuraFrp node hostname: bash gen-cert.sh node1.sakurafrp.com

set -e
PUBLIC=${1:?Usage: gen-cert.sh <public-ip-or-hostname>}

# Determine if it's an IP or hostname
if [[ "$PUBLIC" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:192.168.5.4,IP:$PUBLIC"
else
  SAN="IP:192.168.5.4,DNS:$PUBLIC"
fi

openssl req -x509 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -nodes \
  -keyout key.pem \
  -out cert.pem \
  -days 825 \
  -subj "/CN=screenshare" \
  -addext "subjectAltName=$SAN"

echo "Generated cert.pem and key.pem"
echo "SAN: $SAN"
