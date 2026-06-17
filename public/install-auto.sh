#!/bin/sh
# CF-Server-Monitor unified Linux installer.
# Auto-detect Alpine/OpenRC vs common systemd Linux and delegate to the proper script.
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

is_alpine=0
if [ -f /etc/alpine-release ]; then
  is_alpine=1
elif [ -f /etc/os-release ] && grep -qi '^ID=alpine' /etc/os-release 2>/dev/null; then
  is_alpine=1
fi

if [ "$is_alpine" = "1" ]; then
  echo "[i] 检测到 Alpine Linux，自动切换到 install-alpine.sh"
  exec sh -c "curl -sL '$BASE_URL/install-alpine.sh' | sh -s \"\$@\"" sh "$@"
fi

echo "[i] 检测到通用 Linux，自动切换到 install.sh"
exec sh -c "curl -sL '$BASE_URL/install.sh' | bash -s \"\$@\"" sh "$@"
