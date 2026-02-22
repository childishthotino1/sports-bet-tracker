#!/bin/bash
# ============================================================
# Baltimore Bets — Database helper script
# Usage:
#   ./db.sh seed       → run all seed files (initial setup)
#   ./db.sh bets       → run bets_seed.sql only
#   ./db.sh push FILE  → run any specific .sql file
# ============================================================

# Paste your Supabase connection string here (Settings → Database → URI)
# Format: postgresql://postgres.XXXX:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
DB_URL="${SUPABASE_DB_URL:-}"

if [ -z "$DB_URL" ]; then
  echo ""
  echo "  Error: SUPABASE_DB_URL is not set."
  echo ""
  echo "  Get it from: Supabase → Settings → Database → Connection string (URI)"
  echo ""
  echo "  Then either:"
  echo "    export SUPABASE_DB_URL='postgresql://...'"
  echo "    ./db.sh $1"
  echo ""
  echo "  Or run once directly:"
  echo "    SUPABASE_DB_URL='postgresql://...' ./db.sh $1"
  echo ""
  exit 1
fi

PSQL="/opt/homebrew/opt/libpq/bin/psql"
DIR="$(cd "$(dirname "$0")" && pwd)"

run_sql() {
  local file="$DIR/$1"
  if [ ! -f "$file" ]; then
    echo "  File not found: $file"
    exit 1
  fi
  echo "→ Running $1..."
  "$PSQL" "$DB_URL" -f "$file" --quiet
  echo "  Done."
}

case "${1:-help}" in
  seed)
    echo ""
    echo "Running full seed (schema + update + seed + snapshots + bets)..."
    echo ""
    run_sql schema.sql
    run_sql update.sql
    run_sql seed.sql
    run_sql add_snapshots.sql
    run_sql bets_seed.sql
    echo ""
    echo "All done."
    ;;
  bets)
    echo ""
    run_sql bets_seed.sql
    echo ""
    ;;
  push)
    if [ -z "$2" ]; then
      echo "Usage: ./db.sh push <file.sql>"
      exit 1
    fi
    echo ""
    run_sql "$2"
    echo ""
    ;;
  help|*)
    echo ""
    echo "Usage: ./db.sh <command>"
    echo ""
    echo "  seed       Run all SQL files (full initial setup)"
    echo "  bets       Run bets_seed.sql only"
    echo "  push FILE  Run any specific .sql file"
    echo ""
    ;;
esac
