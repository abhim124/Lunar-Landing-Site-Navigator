#!/usr/bin/env bash
# One-time setup of an Oracle Cloud Always Free Ubuntu server (Ampere A1, arm64) for the backend.
#
#   rsync backend/ (without .env/.venv) to ubuntu@<ip>:/opt/lunar/backend, then on the server:
#   sudo bash /opt/lunar/oracle_server_setup.sh <public-ip> <allowed-origins>
#
# Result: the backend container (auto-restarts, survives reboots) behind Caddy with a free HTTPS
# certificate at https://<ip-with-dashes>.sslip.io. Re-run after uploading new code to rebuild.
# NASA_API_KEY: add a line NASA_API_KEY=... to /opt/lunar/backend.env, then re-run (never in git).
set -euo pipefail

IP="${1:?usage: oracle_server_setup.sh <public-ip> <allowed-origins>}"
ORIGINS="${2:?usage: oracle_server_setup.sh <public-ip> <allowed-origins>}"
HOST="${IP//./-}.sslip.io"
APP=/opt/lunar/backend
ENVF=/opt/lunar/backend.env

export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null || ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get install -y -q docker.io caddy netfilter-persistent iptables-persistent
  systemctl enable --now docker
fi

# Oracle's Ubuntu images REJECT everything but SSH in iptables: open 80 (certificate check) and 443.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null

# Environment for the container; keep any NASA_API_KEY line already there.
touch "$ENVF" && chmod 600 "$ENVF"
grep -v '^CORS_ORIGINS=' "$ENVF" > "$ENVF.tmp" || true
echo "CORS_ORIGINS=$ORIGINS" >> "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF" && chmod 600 "$ENVF"

docker build -t lunar-backend "$APP"
docker rm -f lunar-backend >/dev/null 2>&1 || true
docker run -d --name lunar-backend --restart unless-stopped \
  --env-file "$ENVF" -e PORT=7860 -p 127.0.0.1:8000:7860 lunar-backend

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:8000
}
EOF
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy || systemctl restart caddy

echo "Backend: https://$HOST  (health: https://$HOST/api/health)"
