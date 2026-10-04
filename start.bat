@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Если рядом лежит готовая среда Electron, Node.js не нужен
if exist "runtime\win\electron.exe" (
  start "" "runtime\win\electron.exe" .
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите версию LTS с https://nodejs.org и запустите этот файл снова.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Первый запуск: загружаю Electron, это займёт пару минут...
  call npm install
  if errorlevel 1 (
    echo Установка не удалась. Проверьте доступ в интернет и запустите файл снова.
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" .
