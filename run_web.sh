#!/usr/bin/env bash
# Jalankan antarmuka web Shopee Reviews Crawler.
#   ./run_web.sh            -> http://127.0.0.1:5000
#   PORT=8080 ./run_web.sh  -> port lain
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "Membuat virtualenv .venv ..."
  python3 -m venv --system-site-packages .venv
fi
if ! .venv/bin/python -c "import flask, requests, yaml, tqdm" 2>/dev/null; then
  echo "Memasang dependensi Python dari requirements.txt ..."
  .venv/bin/pip install --quiet -r requirements.txt
fi
if [ ! -d node_modules/playwright-core ]; then
  echo "Memasang dependensi Node (playwright-core) ..."
  npm install
fi
if ! node -e "const fs=require('fs');process.exit(fs.existsSync(require('playwright-core').firefox.executablePath())?0:1)" >/dev/null 2>&1; then
  echo "Mengunduh Firefox untuk Playwright ..."
  node node_modules/playwright-core/cli.js install firefox
fi

PORT="${PORT:-5000}"
echo
echo "  Shopee Reviews Crawler siap di http://127.0.0.1:${PORT}"
echo "  Tekan Ctrl+C untuk berhenti."
echo
exec .venv/bin/python -m web.app
