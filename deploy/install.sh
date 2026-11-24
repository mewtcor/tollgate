#!/usr/bin/env bash
# Builds tollgate-server and installs it as a systemd service. Run from the repo root on the Linux box:
#   ./deploy/install.sh
# Run it again after `git pull` to update; your sign-in, schedules and settings are kept.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cargo >/dev/null || { echo "Install Rust first: curl --proto '=https' -sSf https://sh.rustup.rs | sh"; exit 1; }
command -v cc >/dev/null || { echo "Install a C compiler first: sudo apt install build-essential"; exit 1; }

echo "Building (the first build on an old machine can take 15 minutes or more)..."
cargo build --release -p tollgate-server

sudo id tollgate >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /var/lib/tollgate --shell /usr/sbin/nologin tollgate
sudo install -m 0755 target/release/tollgate-server /usr/local/bin/tollgate-server
sudo install -m 0644 deploy/tollgate.service /etc/systemd/system/tollgate.service

if [ ! -f /etc/tollgate.env ]; then
  read -rsp "Choose a password for the Tollgate web page: " pw; echo
  [ -n "$pw" ] || { echo "A password is required."; exit 1; }
  printf 'TOLLGATE_PASSWORD=%s\n' "$pw" | sudo tee /etc/tollgate.env >/dev/null
  sudo chmod 600 /etc/tollgate.env
fi

sudo systemctl daemon-reload
sudo systemctl enable tollgate >/dev/null
sudo systemctl restart tollgate
sleep 2
systemctl --no-pager --lines=5 status tollgate || true
echo
echo "Open http://$(hostname -I | awk '{print $1}'):8787 from a phone or PC on your network."
