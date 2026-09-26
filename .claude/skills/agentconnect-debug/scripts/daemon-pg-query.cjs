#!/usr/bin/env node
// Read-only reader for a daemon store that lives in PostgreSQL (`store.backend = postgres`, or a pool member).
// Run on the daemon host or inside the pod with the daemon's own Node and bundled pg driver; the connection string
// stays in the data-plane config file it reads. `node daemon-pg-query.cjs <root|config.json> <sql> [param...]`, or
// streamed over SSH: `ssh <host> 'node - <root> "<sql>"' < daemon-pg-query.cjs`.
'use strict'
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const STORE_SCHEMA = 'agentconnect_cloud_store'
const POOL_CONFIG_PATH = '/var/run/ac-data-plane/config.json'
const MAX_STRING = 2000

function fail(message) {
  console.error(message)
  process.exit(2)
}

// A root names its data-plane file through config.json → store.configFile; a pool member reads the mount.
function configPathFor(target) {
  if (target.endsWith('.json')) return target
  const root = resolve(target)
  const configPath = join(root, 'config.json')
  if (!existsSync(configPath)) fail(`no config.json under ${root}`)
  const store = JSON.parse(readFileSync(configPath, 'utf8')).store
  if (store?.backend !== 'postgres')
    fail(`store.backend is ${JSON.stringify(store?.backend ?? 'sqlite')}: use daemon-store.cjs`)
  return resolve(root, store.configFile)
}

// A pool pod has the driver at /app/packages/daemon/node_modules; a self-hosted install is one self-contained bundle with
// pg inlined, so there NODE_PATH must point at a scratch install (`npm --prefix /tmp/ac-debug install pg@8`).
function loadPg(root) {
  const bases = [root, join(root, 'current'), process.cwd(), '/app/packages/daemon', dirname(__filename)]
  try {
    return require(require.resolve('pg', { paths: bases }))
  } catch {
    fail(
      'pg driver not importable here: the published daemon bundles it. Run inside a pool pod, or on the host do\n' +
        '  npm --prefix /tmp/ac-debug install pg@8   (once)\n' +
        '  NODE_PATH=/tmp/ac-debug/node_modules node - <root> "<sql>" < daemon-pg-query.cjs'
    )
  }
}

function clip(value) {
  if (typeof value !== 'string' || value.length <= MAX_STRING) return value
  return `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`
}

async function main(argv) {
  const [target, sql, ...params] = argv
  if (!target || !sql) fail('usage: daemon-pg-query.cjs <root|config.json> <sql> [param...]')
  const configPath = target === 'pool' ? POOL_CONFIG_PATH : configPathFor(target)
  if (!existsSync(configPath)) fail(`no data-plane config at ${configPath}`)
  const { databaseUrl } = JSON.parse(readFileSync(configPath, 'utf8'))
  if (typeof databaseUrl !== 'string') fail(`no databaseUrl in ${configPath}`)
  const { Client } = loadPg(target.endsWith('.json') ? dirname(target) : resolve(target))
  // A distinct application_name keeps this reader apart from the daemon in pg_stat_activity.
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'agentconnect-debug',
    statement_timeout: 60000,
    options: `-c search_path=${STORE_SCHEMA},pg_catalog`
  })
  await client.connect()
  try {
    await client.query('SET default_transaction_read_only = on')
    const res = await client.query(sql, params)
    const rows = res.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)])))
    console.log(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  } finally {
    await client.end()
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message)
  process.exit(1)
})
