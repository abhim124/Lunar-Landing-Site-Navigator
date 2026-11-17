#!/usr/bin/env bash
# One-time setup of an Oracle Cloud Always Free Ubuntu 24.04 server (works on the 1 GB E2.1.Micro and Ampere A1).
#
#   rsync backend/ (only Dockerfile, requirements.txt, app/) to ubuntu@<ip>:/opt/lunar/backend, then on the server:
#   sudo bash /opt/lunar/oracle_server_setup.sh <public-ip> <allowed-origins>
#
# Result: the backend container (auto-restarts, survives reboots) behind Caddy with a free HTTPS
# certificate at https://<ip-with-dashes>.sslip.io. Re-run after uploading new code to rebuild.
# NASA data (about 1 GB) is downloaded once from the public Hugging Face dataset DATA_REPO into /opt/lunar/data.
# NASA_API_KEY: add a line NASA_API_KEY=... to /opt/lunar/backend.env, then re-run (never in git).
set -euo pipefail

IP="${1:?usage: oracle_server_setup.sh <public-ip> <allowed-origins>}"
ORIGINS="${2:?usage: oracle_server_setup.sh <public-ip> <allowed-origins>}"
DATA_REPO="${DATA_REPO:-abhimdubey/lunar-backend-data}"
HOST="${IP//./-}.sslip.io"
APP=/opt/lunar/backend
DATA=/opt/lunar/data
ENVF=/opt/lunar/backend.env

export DEBIAN_FRONTEND=noninteractive

# Small servers (1 GB) need swap for the pip install and the data grids.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

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

# NASA data: download any missing files from the Hugging Face dataset.
mkdir -p "$DATA"
python3 - "$DATA_REPO" "$DATA" <<'PY'
import json, os, sys, urllib.request
repo, dest = sys.argv[1], sys.argv[2]
tree = json.load(urllib.request.urlopen(f"https://huggingface.co/api/datasets/{repo}/tree/main?recursive=true"))
for f in tree:
    if f.get("type") != "file" or f["path"].startswith(".") or f["path"].endswith(".md"):
        continue
    out = os.path.join(dest, f["path"])
    if os.path.exists(out) and os.path.getsize(out) == f.get("size"):
        continue
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print("downloading", f["path"], flush=True)
    urllib.request.urlretrieve(f"https://huggingface.co/datasets/{repo}/resolve/main/{f['path']}", out + ".part")
    os.replace(out + ".part", out)
print("data ready")
PY
mkdir -p "$DATA/cache" && chown -R 1000:1000 "$DATA"

# Environment for the container; keep any NASA_API_KEY line already there.
touch "$ENVF" && chmod 600 "$ENVF"
grep -v '^CORS_ORIGINS=' "$ENVF" > "$ENVF.tmp" || true
echo "CORS_ORIGINS=$ORIGINS" >> "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF" && chmod 600 "$ENVF"

# The image holds code only; the data is mounted (the Dockerfile's COPY data needs the folder to exist).
mkdir -p "$APP/data"
docker build -t lunar-backend "$APP"
docker rm -f lunar-backend >/dev/null 2>&1 || true
docker run -d --name lunar-backend --restart unless-stopped \
  --env-file "$ENVF" -e PORT=7860 -v "$DATA:/home/user/app/data" -p 127.0.0.1:8000:7860 lunar-backend

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:8000
}
EOF
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy || systemctl restart caddy

echo "Backend: https://$HOST  (health: https://$HOST/api/health)"
