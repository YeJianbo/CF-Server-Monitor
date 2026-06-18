#!/bin/sh
# CF-Server-Monitor unified Linux installer.
# Auto-detect OpenWrt/ImmortalWrt, Alpine/OpenRC, and common systemd Linux.
# Ping probing is opt-in: when -ping is omitted, the unified entry adds -ping=off.
set -eu

SELF_URL="${CF_SERVER_MONITOR_INSTALL_URL:-}"
if [ -z "$SELF_URL" ]; then
  # In normal usage this script is fetched from the Worker root.
  # Try to derive the Worker origin from the -url=<WORKER_URL>/update argument.
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

case "$os_id" in
  openwrt|lede|immortalwrt)
    echo "[i] 检测到 OpenWrt/LEDE/ImmortalWrt，自动切换到 install-openwrt.sh"
    exec sh -c "curl -sL '$BASE_URL/install-openwrt.sh' | sh -s \"\$@\"" sh "$@"
    ;;
  alpine)
    echo "[i] 检测到 Alpine Linux，自动切换到 install-alpine.sh"
    exec sh -c "curl -sL '$BASE_URL/install-alpine.sh' | sh -s \"\$@\"" sh "$@"
    ;;
  *)
    if [ -f /etc/alpine-release ] || { command -v apk >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; }; then
      echo "[i] 检测到 apk/OpenRC 环境，自动切换到 install-alpine.sh"
      exec sh -c "curl -sL '$BASE_URL/install-alpine.sh' | sh -s \"\$@\"" sh "$@"
    fi
    echo "[i] 检测到通用 Linux，自动切换到 install.sh"
    exec sh -c "curl -sL '$BASE_URL/install.sh' | bash -s \"\$@\"" sh "$@"
    ;;
esac
