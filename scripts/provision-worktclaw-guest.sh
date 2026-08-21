#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:-}"
if [ -z "$archive_path" ] || [ ! -f "$archive_path" ]; then
  echo "WorkTClaw package archive not found: ${archive_path:-<empty>}" >&2
  exit 1
fi

install_root=$(mktemp -d /opt/worktclaw-install.XXXXXX)
chmod 0755 "$install_root"
cleanup() {
  rm -rf "$install_root"
}
trap cleanup EXIT

tar -xzf "$archive_path" -C "$install_root"
package_installer=$(find "$install_root" -maxdepth 3 -type f -name install.sh -print | head -n 1)
if [ -z "$package_installer" ]; then
  echo "WorkTClaw install.sh was not found in $archive_path" >&2
  exit 1
fi

install -d -m 0755 -o worktoper -g worktoper /home/worktoper
cd /home/worktoper
runuser -u worktoper -- env -i \
  HOME=/home/worktoper \
  USER=worktoper \
  LOGNAME=worktoper \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  QWENPAW_HOME=/home/worktoper/.qwenpaw \
  bash "$package_installer"

if [ ! -f /home/worktoper/.qwenpaw/config.json ]; then
  runuser -u worktoper -- env -i \
    HOME=/home/worktoper \
    USER=worktoper \
    LOGNAME=worktoper \
    PATH=/home/worktoper/.qwenpaw/bin:/home/worktoper/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    QWENPAW_HOME=/home/worktoper/.qwenpaw \
    /home/worktoper/.qwenpaw/bin/worktclaw init --defaults --accept-security
fi

install -m 0644 /dev/stdin /etc/systemd/system/worktclaw.service <<'UNIT'
[Unit]
Description=WorkTClaw Agent Robot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=worktoper
Group=worktoper
WorkingDirectory=/home/worktoper
Environment=HOME=/home/worktoper
Environment=USER=worktoper
Environment=LOGNAME=worktoper
Environment=QWENPAW_HOME=/home/worktoper/.qwenpaw
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/worktoper/.qwenpaw/bin/worktclaw app --host 0.0.0.0 --port 8088 --log-level info
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable worktclaw.service
systemctl restart worktclaw.service

for attempt in $(seq 1 90); do
  if curl -fsS --max-time 2 http://127.0.0.1:8088/api/version >/tmp/worktclaw-version.json; then
    cat /tmp/worktclaw-version.json
    echo
    echo "WorkTClaw is ready on port 8088"
    exit 0
  fi
  sleep 2
done

systemctl status worktclaw.service --no-pager || true
journalctl -u worktclaw.service -n 120 --no-pager || true
echo "WorkTClaw did not become ready on port 8088" >&2
exit 1
