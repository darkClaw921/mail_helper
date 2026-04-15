#!/usr/bin/env bash
# Mail Helper setup + launch script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
ENV_FILE="$WEBAPP_DIR/.env"
ENV_EXAMPLE="$WEBAPP_DIR/.env.example"
EXT_DIR="$SCRIPT_DIR/extension"

C_RESET='\033[0m'; C_INFO='\033[1;34m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'
info(){ printf "${C_INFO}[i]${C_RESET} %s\n" "$*"; }
ok(){   printf "${C_OK}[✓]${C_RESET} %s\n" "$*"; }
warn(){ printf "${C_WARN}[!]${C_RESET} %s\n" "$*"; }
err(){  printf "${C_ERR}[x]${C_RESET} %s\n" "$*" >&2; }

# 1. Node >=20 check
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not installed. Need >=20. Install: https://nodejs.org"; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node $NODE_MAJOR found. Need >=20."; exit 1
fi
ok "Node $(node -v) OK"

# 2. npm check
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found"; exit 1
fi

# 3. webapp dir check
if [ ! -d "$WEBAPP_DIR" ]; then
  err "webapp/ not found at $WEBAPP_DIR"; exit 1
fi
cd "$WEBAPP_DIR"

# 4. Install deps
if [ ! -d "node_modules" ]; then
  info "Installing npm dependencies (first run, may take a minute)..."
  npm install --silent
  ok "Dependencies installed"
else
  ok "node_modules present, skip install"
fi

# 5. .env bootstrap
if [ ! -f "$ENV_FILE" ]; then
  if [ ! -f "$ENV_EXAMPLE" ]; then
    err ".env.example missing"; exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  ok ".env created from .env.example"
fi

# 6. MASTER_KEY generation if empty
MASTER_KEY_VAL=$(grep -E '^MASTER_KEY=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || true)
if [ -z "${MASTER_KEY_VAL}" ]; then
  NEW_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  # portable in-place sed (GNU + BSD)
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^MASTER_KEY=.*|MASTER_KEY=${NEW_KEY}|" "$ENV_FILE"
  else
    sed -i '' "s|^MASTER_KEY=.*|MASTER_KEY=${NEW_KEY}|" "$ENV_FILE"
  fi
  ok "MASTER_KEY generated and written to .env"
else
  ok "MASTER_KEY already set"
fi

# 7. DB init
DB_PATH_VAL=$(grep -E '^DB_PATH=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || echo "./data.db")
[ -z "$DB_PATH_VAL" ] && DB_PATH_VAL="./data.db"
if [ ! -f "$WEBAPP_DIR/$DB_PATH_VAL" ]; then
  info "Initializing SQLite database..."
  npm run init-db --silent
  ok "Database initialized at $DB_PATH_VAL"
else
  # idempotent re-run to apply any schema additions
  npm run init-db --silent >/dev/null 2>&1 || true
  ok "Database present"
fi

# 8. Port availability check — pick a free port if current one is busy
PORT_VAL=$(grep -E '^PORT=' "$ENV_FILE" | head -n1 | cut -d'=' -f2- || echo "3000")
[ -z "$PORT_VAL" ] && PORT_VAL="3000"

port_busy() {
  # 0 = busy, 1 = free
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (echo >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
  fi
}

if port_busy "$PORT_VAL"; then
  warn "Port $PORT_VAL is busy"
  NEW_PORT=""
  for candidate in 3100 3200 3300 4000 4100 5000 8000 8080 8888; do
    if ! port_busy "$candidate"; then NEW_PORT="$candidate"; break; fi
  done
  if [ -z "$NEW_PORT" ]; then
    err "No free port found in candidates. Set PORT manually in $ENV_FILE"; exit 1
  fi
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^PORT=.*|PORT=${NEW_PORT}|" "$ENV_FILE"
  else
    sed -i '' "s|^PORT=.*|PORT=${NEW_PORT}|" "$ENV_FILE"
  fi
  PORT_VAL="$NEW_PORT"
  ok "Switched PORT to $NEW_PORT in .env"
else
  ok "Port $PORT_VAL free"
fi

echo
info "==================== Mail Helper ready ===================="
info "Web UI:      http://localhost:5173"
info "Backend:     http://localhost:$PORT_VAL"
info "WebSocket:   ws://localhost:$PORT_VAL/ws"
info "Extension:   load unpacked → $EXT_DIR"

# Extract api_key (generate on first call via auth.ensureApiKey)
API_KEY_VAL=$(node -e "import('./server/api/auth.js').then(m => { process.stdout.write(m.ensureApiKey()); process.exit(0); })" 2>/dev/null || echo "")
if [ -n "$API_KEY_VAL" ]; then
  info "API key:     $API_KEY_VAL"
else
  warn "API key:     failed to read (check backend log)"
fi
echo
info "Starting dev server (Ctrl+C to stop)..."
echo

# 9. Launch
exec npm run dev
