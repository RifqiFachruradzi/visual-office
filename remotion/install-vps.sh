#!/usr/bin/env bash
# =========================================================================
# install-vps.sh — pasang / perbarui WORKER RENDER VIDEO Visual Office di VPS (Rocky / Alma / RHEL 8–9,
# juga Debian / Ubuntu). Worker berjalan di kontainer Podman sehingga tidak mengganggu layanan lain
# (mis. 9router) dan tidak butuh domain / port terbuka: worker yang menghubungi Visual Office.
#
#   curl -fsSL https://raw.githubusercontent.com/RifqiFachruradzi/visual-office/main/remotion/install-vps.sh | sudo bash
#
# Jalankan ulang perintah yang sama untuk memperbarui (pengaturan di /etc/visual-office-worker.env tetap).
# Opsi env: VO_URL (default https://visual-office.vercel.app), PEXELS_API_KEY.
# =========================================================================
set -euo pipefail

REPO="${REPO:-https://github.com/RifqiFachruradzi/visual-office.git}"
BRANCH="${BRANCH:-main}"
DIR=/opt/visual-office
ENVF=/etc/visual-office-worker.env
IMAGE=visual-office-worker
SVC=visual-office-worker
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root (sudo)."; exit 1; }

say "1/6 Swap (RAM 2 GB butuh cadangan saat render)"
if ! swapon --show | grep -q .; then
  fallocate -l 3G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=3072
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 3 GB aktif"
else
  echo "swap sudah ada:"; swapon --show
fi

say "2/6 Paket: git, podman, openssl"
if command -v dnf >/dev/null; then dnf install -y git podman openssl
elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y git podman openssl
else echo "Package manager tidak dikenal — pasang git & podman manual."; exit 1; fi

say "3/6 Kode Visual Office → $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard "origin/$BRANCH"
else git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"; fi

say "4/6 Pengaturan worker → $ENVF"
if [ ! -f "$ENVF" ]; then
  SECRET="$(openssl rand -hex 24)"
  cat > "$ENVF" <<EOF
# Worker render video Visual Office — ubah lalu: systemctl restart $SVC
VO_URL=${VO_URL:-https://visual-office.vercel.app}
# Sama persis dengan env RENDER_WORKER_SECRET di Vercel
RENDER_WORKER_SECRET=$SECRET
# (opsional) foto/video stok gratis: https://www.pexels.com/api/  → isi kuncinya di sini
PEXELS_API_KEY=${PEXELS_API_KEY:-}
RENDER_CONCURRENCY=1
EOF
  chmod 600 "$ENVF"
  NEW=1
else
  NEW=0
  if [ -n "${PEXELS_API_KEY:-}" ]; then sed -i "s|^PEXELS_API_KEY=.*|PEXELS_API_KEY=$PEXELS_API_KEY|" "$ENVF"; fi
  echo "pengaturan lama dipakai"
fi

say "5/6 Build image kontainer (pertama kali ±5–10 menit)"
podman build -t "$IMAGE" "$DIR/remotion"
podman image prune -f >/dev/null 2>&1 || true

say "   tes render singkat di dalam kontainer…"
if podman run --rm "$IMAGE" node worker.mjs --test bold --still > /tmp/vo-worker-selftest.log 2>&1; then
  echo "tes render OK"
else
  echo "TES RENDER GAGAL — log: /tmp/vo-worker-selftest.log"; tail -20 /tmp/vo-worker-selftest.log; exit 1
fi

say "6/6 Layanan systemd: $SVC"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Visual Office — worker render video (Remotion)
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=-/usr/bin/podman rm -f $SVC
ExecStart=/usr/bin/podman run --rm --name $SVC --env-file $ENVF $IMAGE
ExecStop=/usr/bin/podman stop -t 30 $SVC
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null
systemctl restart "$SVC"
sleep 8
systemctl --no-pager --lines=5 status "$SVC" || true

# shellcheck disable=SC1090
. "$ENVF"
echo
echo "================================================================"
echo " Worker render video terpasang."
if [ "$NEW" = 1 ]; then
  echo
  echo " LANGKAH TERAKHIR — di Vercel → Settings → Environment Variables tambahkan:"
  echo "   RENDER_WORKER_SECRET = $RENDER_WORKER_SECRET"
  echo " lalu Redeploy. (Narasi suara memakai GEMINI_API_KEY yang sudah ada di Vercel.)"
fi
echo
echo " Log worker   : journalctl -u $SVC -f"
echo " Pengaturan   : nano $ENVF  lalu  systemctl restart $SVC"
echo " Perbarui     : jalankan ulang perintah instalasi"
echo "================================================================"
