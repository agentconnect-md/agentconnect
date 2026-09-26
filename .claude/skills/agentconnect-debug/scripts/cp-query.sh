#!/usr/bin/env bash
# Run one parameterized, read-only SQL statement inside a Control Plane pod, with the pod's own DATABASE_URL and bundled pg driver.
# usage: cp-query.sh [kubectl flags, e.g. --context X -n Y] -- <pod|deployment/name> <sql> [param...]
# Every literal goes in as a $n parameter; the container defaults to `control-plane` (override with CP_CONTAINER).
set -euo pipefail

usage() {
  echo "usage: $0 [kubectl flags] -- <pod|deployment/name> <sql> [param...]" >&2
  exit 2
}

KARGS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  KARGS+=("$1")
  shift
done
[ $# -ge 3 ] || usage
shift
TARGET=$1
SQL=$2
shift 2

# The driver is a transitive dependency of the Prisma adapter, so resolve it from the adapter before searching the image.
read -r -d '' JS << 'EOF' || true
const [sql, ...params] = process.argv.slice(1)
const { execSync } = require('node:child_process')
const { dirname } = require('node:path')
function loadPg() {
  const bases = [process.cwd(), '/app/packages/control-plane']
  try { bases.push(dirname(require.resolve('@prisma/adapter-pg/package.json', { paths: bases }))) } catch {}
  try { return require(require.resolve('pg', { paths: bases })) } catch {}
  const found = execSync("find / -maxdepth 10 -type d -name pg -path '*node_modules*' -not -path '*/pg/*' 2>/dev/null | head -1", { encoding: 'utf8' }).trim()
  if (!found) throw new Error('pg driver not found in this image')
  return require(found)
}
const { Client } = loadPg()
const client = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 60000 })
;(async () => {
  await client.connect()
  await client.query('SET default_transaction_read_only = on')
  const res = await client.query(sql, params)
  console.log(JSON.stringify(res.rows, null, 2))
  await client.end()
})().catch((err) => { console.error(err.message); process.exit(1) })
EOF

exec kubectl "${KARGS[@]}" exec "$TARGET" -c "${CP_CONTAINER:-control-plane}" -- node -e "$JS" -- "$SQL" "$@"
