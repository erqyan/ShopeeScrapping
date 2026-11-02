@echo off
setlocal EnableExtensions
title Shopee Crawler - Chrome Debug (CDP)
set "PORT=9222"
set "CDP=http://127.0.0.1:%PORT%/json/version"
set "PROFILE=%LOCALAPPDATA%\ShopeeCrawlerChrome"

if not defined LOCALAPPDATA (
  echo Folder LOCALAPPDATA tidak ditemukan. Jalankan script ini dari
  echo Command Prompt biasa, bukan sebagai service / SYSTEM.
  pause
  exit /b 1
)

echo ============================================================
echo  Chrome untuk crawling Shopee (mode CDP)
echo ============================================================
echo.
echo Profil Chrome : %PROFILE%
echo Port debug    : %PORT%
echo.

call :check_cdp
if not errorlevel 1 (
  echo Chrome debug SUDAH aktif di port %PORT%.
  echo.
  echo Langkah berikutnya:
  echo   1. Pastikan sudah login ke Shopee di Chrome itu.
  echo   2. Jalankan run_web.bat.
  echo   3. Klik Mulai Crawl - crawler akan memakai Chrome ini otomatis.
  echo.
  echo Jendela ini boleh ditutup.
  pause
  exit /b 0
)

echo Chrome 136+ tidak mengizinkan port debug pada profil Chrome utama.
echo Script ini memakai profil khusus crawler supaya CDP bisa aktif.
echo Chrome utama kamu boleh tetap terbuka; tab-tabnya tidak terganggu.
echo.

if not exist "%PROFILE%" (
  echo Membuat profil Chrome khusus crawler...
  mkdir "%PROFILE%" >nul 2>&1
)

rem Cari chrome.exe di lokasi instalasi standar.
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined CHROME if exist "%%~P" set "CHROME=%%~P"
)

if not defined CHROME (
  echo.
  echo Chrome tidak ditemukan di lokasi standar.
  echo.
  echo Buka chrome://version di Chrome, lihat "Executable Path", lalu
  echo jalankan manual dari Command Prompt:
  echo.
  echo   "C:\path\ke\chrome.exe" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%"
  echo.
  pause
  exit /b 1
)

echo.
echo Menjalankan Chrome dengan profil crawler...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-background-mode --remote-allow-origins=* https://shopee.co.id/

set /a TRIES=0

:wait_cdp
set /a TRIES+=1
timeout /t 1 /nobreak >nul
call :check_cdp
if not errorlevel 1 goto cdp_ok
if %TRIES% GEQ 20 goto cdp_failed
goto wait_cdp

:cdp_ok
echo.
echo CDP AKTIF di http://127.0.0.1:%PORT%
echo.
echo Langkah berikutnya:
echo   1. Login ke Shopee di jendela Chrome yang baru terbuka.
echo   2. Jalankan run_web.bat.
echo   3. Klik Mulai Crawl - crawler akan memakai Chrome ini otomatis.
echo.
echo Login cukup sekali. Profil tersimpan di:
echo   %PROFILE%
echo.
echo Jendela ini boleh ditutup. Chrome harus tetap terbuka selama crawling.
echo.
pause
exit /b 0

:cdp_failed
echo.
echo CDP BELUM aktif di port %PORT%.
echo.
echo Info proses Chrome:
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | findstr /I "chrome.exe"
if errorlevel 1 echo   - Tidak ada proses chrome.exe yang terdeteksi.
echo.
echo Info port %PORT%:
netstat -ano | findstr ":%PORT%" | findstr "LISTENING"
if errorlevel 1 echo   - Tidak ada yang listen di port %PORT%.
echo.
echo Versi Chrome:
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Item '%CHROME%').VersionInfo.ProductVersion" 2>nul
echo.
echo Coba langkah ini:
echo   1. Tutup jendela Chrome yang memakai profil crawler (kalau ada).
echo   2. Jalankan manual dari Command Prompt supaya pesan Chrome terlihat:
echo      "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%"
echo   3. Buka http://127.0.0.1:%PORT%/json/version di browser.
echo.
pause
exit /b 1

:check_cdp
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%CDP%'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%
