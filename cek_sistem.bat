@echo off
setlocal
cd /d "%~dp0"
title Cek Sistem - Shopee Reviews Crawler

echo ============ Cek sistem Shopee Reviews Crawler ============
echo.

echo [Python]
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; print('  ', sys.version.split()[0])"
) else (
  echo    .venv belum ada - jalankan run_web.bat dulu
)
echo.

echo [Node.js]
where node >nul 2>nul
if errorlevel 1 (
  echo    TIDAK ADA - install dari https://nodejs.org
) else (
  node --version
)
echo.

echo [playwright-core + Firefox + cookie]
if exist "node_modules\playwright-core\cli.js" (
  node browser_crawl.mjs --check --cookies "web\data\cookies.txt"
) else (
  echo    node_modules belum ada - jalankan: npm install
)
echo.
echo ==========================================================
pause
