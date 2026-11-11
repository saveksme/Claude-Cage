#!/usr/bin/env bash
set -euo pipefail
if systemctl is-active --quiet cage-claude-desktop.service; then
  test -f /run/cage-desktop/keyring-ready || { echo 'Сначала сохраните работу и закройте текущий Claude Desktop, затем откройте его заново с аккаунтом Cage.' >&2; exit 1; }
  exit 0
fi
if systemctl is-failed --quiet cage-claude-desktop.service; then
  sudo systemctl reset-failed cage-claude-desktop.service
fi
sudo systemctl start --no-block cage-claude-desktop.service
for i in $(seq 1 150); do
  if [ -p /run/cage-desktop/unlock ]; then break; fi
  if systemctl is-failed --quiet cage-claude-desktop.service; then
    echo 'Графический сеанс не удалось запустить.' >&2; exit 1
  fi
  sleep .1
done
test -p /run/cage-desktop/unlock || { echo 'Истекло время ожидания канала разблокировки учётных данных.' >&2; exit 1; }
# The internal random key comes exclusively from SSH stdin, never argv or disk.
timeout 10 sh -c 'cat > /run/cage-desktop/unlock'
for i in $(seq 1 300); do
  if systemctl is-active --quiet cage-claude-desktop.service; then exit 0; fi
  if systemctl is-failed --quiet cage-claude-desktop.service; then
    echo 'Claude Desktop не удалось запустить или связка ключей не разблокирована; существующие данные входа не изменены.' >&2; exit 1
  fi
  sleep .1
done
echo 'Истекло время ожидания запуска Claude Desktop.' >&2
exit 1
