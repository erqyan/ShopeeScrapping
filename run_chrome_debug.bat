@echo off
setlocal EnableExtensions
title Shopee Crawler - Chrome Debug (CDP)
set "PORT=9222"
set "CDP=http://127.0.0.1:%PORT%/json/version"

echo ============================================================
echo  Chrome untuk crawling Shopee (mode CDP)
echo ============================================================
echo.

rem Kalau port debug sudah aktif, tidak perlu buka Chrome lagi.
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

echo Penting: tutup SEMUA jendela Chrome dulu, termasuk yang masih
echo berjalan di background / system tray.
echo.
echo Kalau Chrome masih berjalan, port debug tidak akan aktif dan
echo crawler akan memakai Firefox biasa.
echo.
echo Tekan tombol apa saja kalau Chrome sudah benar-benar tertutup...
pause >nul

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
  echo   "C:\path\ke\chrome.exe" --remote-debugging-port=%PORT%
  echo.
  pause
  exit /b 1
)

echo.
echo Menjalankan Chrome dengan port debug %PORT%...
start "" "%CHROME%" --remote-debugging-port=%PORT% https://shopee.co.id/

set /a TRIES=0

:wait_cdp
set /a TRIES+=1
timeout /t 1 /nobreak >nul
call :check_cdp
if not errorlevel 1 goto cdp_ok
if %TRIES% GEQ 15 goto cdp_failed
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
echo Jendela ini boleh ditutup. Chrome harus tetap terbuka selama crawling.
echo.
pause
exit /b 0

:cdp_failed
echo.
echo CDP BELUM aktif di port %PORT%.
echo.
echo Kemungkinan penyebab:
echo   - Masih ada proses Chrome lain yang berjalan.
echo   - Chrome dibuka lewat profil/launcher lain.
echo   - Port %PORT% dipakai aplikasi lain.
echo.
echo Coba lagi:
echo   1. Tutup semua Chrome, termasuk dari Task Manager (chrome.exe).
echo   2. Jalankan run_chrome_debug.bat ini sekali lagi.
echo   3. Cek manual: buka http://127.0.0.1:%PORT%/json/version di browser.
echo.
pause
exit /b 1

:check_cdp
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%CDP%'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%
