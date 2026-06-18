#!/bin/sh
# CF-Server-Monitor unified Linux installer.
# Auto-detect OpenWrt/ImmortalWrt, Alpine/OpenRC, and common systemd Linux.
# Ping probing is opt-in: when -ping is omitted, the unified entry adds -ping=off.
# Also installs a lightweight config-sync daemon so future panel edits can apply online.
set -eu

SELF_URL="${CF_SERVER_MONITOR_INSTALL_URL:-}"
ACTION=""
SERVER_ID=""
SECRET=""
WORKER_URL=""

for arg in "$@"; do
  case "$arg" in
    install|uninstall) ACTION="$arg" ;;
    -id=*) SERVER_ID=${arg#-id=} ;;
    -secret=*) SECRET=${arg#-secret=} ;;
    -url=*) WORKER_URL=${arg#-url=} ;;
  esac
done

if [ -z "$SELF_URL" ]; then
  for arg in "$@"; do
    case "$arg" in
      -url=*)
        update_url=${arg#-url=}
        SELF_URL=${update_url%/update}/install-auto.sh
        ;;
    esac
  done
fi

if [ -n "$SELF_URL" ]; then
  BASE_URL=${SELF_URL%/install-auto.sh}
else
  echo "[!] 未能自动推导安装脚本地址，请使用: CF_SERVER_MONITOR_INSTALL_URL=https://你的项目/install-auto.sh sh install-auto.sh ..." >&2
  exit 1
fi

has_ping=0
for arg in "$@"; do
  case "$arg" in
    -ping=*|--ping=*) has_ping=1 ;;
  esac
done

if [ "$has_ping" = "0" ]; then
  set -- "$@" -ping=off
fi

os_id="unknown"
if [ -f /etc/os-release ]; then
  os_id=$(grep -E '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"' | tr -d "'" | tr '[:upper:]' '[:lower:]' 2>/dev/null || echo unknown)
elif [ -f /etc/openwrt_release ]; then
  os_id="openwrt"
elif [ -f /etc/alpine-release ]; then
  os_id="alpine"
fi

TARGET_SCRIPT="install.sh"
TARGET_SHELL="bash"
case "$os_id" in
  openwrt|lede|immortalwrt)
    echo "[i] 检测到 OpenWrt/LEDE/ImmortalWrt，自动切换到 install-openwrt.sh"
    TARGET_SCRIPT="install-openwrt.sh"
    TARGET_SHELL="sh"
    ;;
  alpine)
    echo "[i] 检测到 Alpine Linux，自动切换到 install-alpine.sh"
    TARGET_SCRIPT="install-alpine.sh"
    TARGET_SHELL="sh"
    ;;
  *)
    if [ -f /etc/alpine-release ] || { command -v apk >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; }; then
      echo "[i] 检测到 apk/OpenRC 环境，自动切换到 install-alpine.sh"
      TARGET_SCRIPT="install-alpine.sh"
      TARGET_SHELL="sh"
    else
      echo "[i] 检测到通用 Linux，自动切换到 install.sh"
    fi
    ;;
esac

sq() {
  printf "%s" "$1" | sed "s/'/'\\''/g"
}

remove_config_sync() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now cf-probe-config-sync.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/cf-probe-config-sync.service
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -f /etc/init.d/cf-probe-config-sync ]; then
    /etc/init.d/cf-probe-config-sync stop >/dev/null 2>&1 || true
    /etc/init.d/cf-probe-config-sync disable >/dev/null 2>&1 || true
    command -v rc-update >/dev/null 2>&1 && rc-update del cf-probe-config-sync default >/dev/null 2>&1 || true
    rm -f /etc/init.d/cf-probe-config-sync
  fi
  pkill -f cf-probe-config-sync.sh >/dev/null 2>&1 || true
  rm -f /usr/local/bin/cf-probe-config-sync.sh
}

install_config_sync() {
  [ "$ACTION" = "install" ] || return 0
  [ -n "$SERVER_ID" ] && [ -n "$SECRET" ] && [ -n "$WORKER_URL" ] || return 0

  mkdir -p /usr/local/bin /etc/cf-probe 2>/dev/null || true
  SYNC_SCRIPT="/usr/local/bin/cf-probe-config-sync.sh"
  SID=$(sq "$SERVER_ID")
  SSEC=$(sq "$SECRET")
  SURL=$(sq "$WORKER_URL")

  cat > "$SYNC_SCRIPT" <<EOF
#!/bin/sh
set -u
SERVER_ID='$SID'
SECRET='$SSEC'
WORKER_URL='$SURL'
BASE_URL="\${WORKER_URL%/update}"
CONFIG_URL="\${BASE_URL}/api/agent-config?id=\${SERVER_ID}&secret=\${SECRET}"
STATE_FILE="/etc/cf-probe/live-config.env"
SERVICE_FILE="/etc/systemd/system/cf-probe.service"
INIT_FILE="/etc/init.d/cf-probe"
SCRIPT_FILE="/usr/local/bin/cf-probe.sh"

json_str() { printf '%s' "\$1" | sed -n "s/.*\\\"\$2\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p"; }
json_num() { printf '%s' "\$1" | sed -n "s/.*\\\"\$2\\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p"; }
esc_sed() { printf '%s' "\$1" | sed 's/[\\&|]/\\\\&/g'; }

read_state() {
  [ -f "\$STATE_FILE" ] && cat "\$STATE_FILE" || true
}

write_state() {
  mkdir -p /etc/cf-probe 2>/dev/null || true
  cat > "\$STATE_FILE" <<STATE
INTERVAL=\$1
PING=\$2
RESET_DAY=\$3
CT=\$4
CU=\$5
CM=\$6
BD=\$7
STATE
}

apply_config() {
  interval="\$1"; ping="\$2"; reset_day="\$3"; ct="\$4"; cu="\$5"; cm="\$6"; bd="\$7"
  old="\$(read_state)"
  new="INTERVAL=\$interval
PING=\$ping
RESET_DAY=\$reset_day
CT=\$ct
CU=\$cu
CM=\$cm
BD=\$bd"
  [ "\$old" = "\$new" ] && return 0

  eurl="\$(esc_sed "\$WORKER_URL")"
  repl="\\\"\$eurl\\\" \\\"\$interval\\\" \\\"\$ping\\\" \\\"\$(esc_sed "\$ct")\\\" \\\"\$(esc_sed "\$cu")\\\" \\\"\$(esc_sed "\$cm")\\\" \\\"\$(esc_sed "\$bd")\\\" \\\"\$reset_day\\\""

  if [ -f "\$SERVICE_FILE" ] && command -v systemctl >/dev/null 2>&1; then
    sed -i -E "s|\\\"\$eurl\\\" \\\"[0-9]+\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[0-9]+\\\"|\$repl|g" "\$SERVICE_FILE" || true
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl restart cf-probe.service >/dev/null 2>&1 || true
  elif [ -f "\$INIT_FILE" ]; then
    sed -i -E "s|\\\"\$eurl\\\" \\\"[0-9]+\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[^\\\"]*\\\" \\\"[0-9]+\\\"|\$repl|g" "\$INIT_FILE" || true
    "\$INIT_FILE" restart >/dev/null 2>&1 || rc-service cf-probe restart >/dev/null 2>&1 || true
  fi
  write_state "\$interval" "\$ping" "\$reset_day" "\$ct" "\$cu" "\$cm" "\$bd"
}

while true; do
  body="\$(curl -fsS -m 6 --connect-timeout 3 "\$CONFIG_URL" 2>/dev/null || true)"
  if [ -n "\$body" ]; then
    interval="\$(json_num "\$body" report_interval)"; interval="\${interval:-180}"
    ping="\$(json_str "\$body" ping_mode)"; ping="\${ping:-off}"
    reset_day="\$(json_num "\$body" reset_day)"; reset_day="\${reset_day:-1}"
    ct="\$(json_str "\$body" custom_ct)"
    cu="\$(json_str "\$body" custom_cu)"
    cm="\$(json_str "\$body" custom_cm)"
    bd="\$(json_str "\$body" custom_bd)"
    apply_config "\$interval" "\$ping" "\$reset_day" "\$ct" "\$cu" "\$cm" "\$bd"
  fi
  sleep 300
 done
EOF
  chmod +x "$SYNC_SCRIPT"

  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/cf-probe-config-sync.service <<EOF
[Unit]
Description=CF Server Monitor Probe Config Sync
After=network-online.target cf-probe.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh $SYNC_SCRIPT
Restart=always
RestartSec=30
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now cf-probe-config-sync.service >/dev/null 2>&1 || true
  elif [ -f /sbin/procd ] || command -v procd >/dev/null 2>&1; then
    cat > /etc/init.d/cf-probe-config-sync <<EOF
#!/bin/sh /etc/rc.common
START=98
USE_PROCD=1
start_service() {
  procd_open_instance
  procd_set_param command /bin/sh $SYNC_SCRIPT
  procd_set_param respawn 3600 5 5
  procd_close_instance
}
EOF
    chmod +x /etc/init.d/cf-probe-config-sync
    /etc/init.d/cf-probe-config-sync enable >/dev/null 2>&1 || true
    /etc/init.d/cf-probe-config-sync restart >/dev/null 2>&1 || true
  elif command -v rc-service >/dev/null 2>&1; then
    cat > /etc/init.d/cf-probe-config-sync <<EOF
#!/sbin/openrc-run
command="/bin/sh"
command_args="$SYNC_SCRIPT"
command_background="yes"
pidfile="/var/run/cf-probe-config-sync.pid"
EOF
    chmod +x /etc/init.d/cf-probe-config-sync
    rc-update add cf-probe-config-sync default >/dev/null 2>&1 || true
    rc-service cf-probe-config-sync restart >/dev/null 2>&1 || true
  else
    nohup /bin/sh "$SYNC_SCRIPT" >/tmp/cf-probe-config-sync.log 2>&1 &
  fi

  echo "[i] 已安装探针在线配置同步服务"
}

if [ "$TARGET_SHELL" = "bash" ]; then
  curl -sL "$BASE_URL/$TARGET_SCRIPT" | bash -s "$@"
else
  curl -sL "$BASE_URL/$TARGET_SCRIPT" | sh -s "$@"
fi

if [ "$ACTION" = "uninstall" ]; then
  remove_config_sync
elif [ "$ACTION" = "install" ]; then
  install_config_sync
fi
