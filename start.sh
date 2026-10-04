#!/bin/sh
# Запуск под Linux. Нужен Node.js версии LTS.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите версию LTS и запустите файл снова."
  exit 1
fi
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "Первый запуск: загружаю Electron, это займёт пару минут..."
  npm install || exit 1
fi
exec node_modules/electron/dist/electron .
