@echo off
setlocal
cd /d "%~dp0"
title Shopee Reviews Crawler

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js belum terpasang. Ambil versi LTS di https://nodejs.org
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/4] Membuat virtualenv .venv ...
  py -3 -m venv --system-site-packages .venv 2>nul
  if not exist ".venv\Scripts\python.exe" python -m venv --system-site-packages .venv
  if not exist ".venv\Scripts\python.exe" (
    echo [X] Gagal membuat virtualenv. Pastikan Python 3.10+ terpasang.
    pause
    exit /b 1
  )
)

".venv\Scripts\python.exe" -c "import flask, requests, yaml, tqdm" >nul 2>nul
if errorlevel 1 (
  echo [2/4] Memasang dependensi Python dari requirements.txt ...
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip >nul 2>nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [X] Gagal memasang dependensi Python.
    pause
    exit /b 1
  )
)

if not exist "node_modules\playwright-core" (
  echo [3/4] Memasang dependensi Node ^(playwright-core^) ...
  call npm install
  if errorlevel 1 (
    echo [X] Gagal menjalankan npm install.
    pause
    exit /b 1
  )
)

node -e "require('playwright-core').firefox.executablePath()" >nul 2>nul
if errorlevel 1 (
  echo [4/4] Mengunduh Firefox untuk Playwright ^(sekali saja, sekitar 90 MB^) ...
  call npx playwright install firefox
  if errorlevel 1 (
    echo [X] Gagal mengunduh Firefox Playwright.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=5000
echo.
echo   Shopee Reviews Crawler siap di http://127.0.0.1:%PORT%
echo   Tutup jendela ini atau tekan Ctrl+C untuk berhenti.
echo.
".venv\Scripts\python.exe" -m web.app
pause
