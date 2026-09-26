#!/usr/bin/env node
// Read-only reader for a daemon's <root>/state/local.sqlite, run with the host's own Node (node:sqlite, Node >= 22.13).
// Run as a file, or stream it over SSH without copying anything: `ssh <host> 'node - sessions <root>' < daemon-store.cjs`.
'use strict'
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const USAGE = [
  'usage:',
  '  daemon-store.cjs leaf <sessionKey>                                 the session directory leaf for a session key',
  '  daemon-store.cjs sessions <root|sqlite> [needle]                   sessions with ids, executor, outcome, leaf; needle matches key, sessionId, acpSessionId',
  '  daemon-store.cjs tools <root|sqlite> <channel> [thread] [--session <sessionKey>] [--limit <n>] [--tail]',
  '                                                                     tool rows of one conversation as metadata only, oldest first (--tail: newest); --session keeps one session',
  '  daemon-store.cjs tools <root|sqlite> <channel> [thread] --seq <n> --raw',
  '                                                                     the command and output preview of ONE row; may hold secrets, never paste it into public text',
  '  daemon-store.cjs query <root|sqlite> <sql> [param...]              one read-only statement, rows as JSON'
].join('\n')

const MAX_STRING = 2000

function fail(message) {
  console.error(message)
  process.exit(2)
}

function leaf(sessionKey) {
  return `session-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`
}

function open(target) {
  const { DatabaseSync } = require('node:sqlite')
  const path = target.endsWith('.sqlite') ? target : join(target, 'state', 'local.sqlite')
  if (!existsSync(path)) fail(`no store at ${path}`)
  return new DatabaseSync(path, { readOnly: true })
}

function clip(value) {
  if (typeof value !== 'string' || value.length <= MAX_STRING) return value
  return `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`
}

function isoIfEpoch(value) {
  return typeof value === 'number' && value > 1e12 ? new Date(value).toISOString() : value
}

function printJson(rows) {
  const out = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)])))
  console.log(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

function parseBody(body) {
  if (typeof body !== 'string') return {}
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

// A shell tool's command and output live in free-form ACP fields, so probe the usual names and fall back to a preview.
function describeTool(row) {
  const body = parseBody(row.body)
  const input = body.rawInput ?? {}
  const output = body.rawOutput
  const command = Array.isArray(input.command)
    ? input.command.join(' ')
    : (input.command ?? input.path ?? input.pattern ?? row.text ?? '')
  const text =
    typeof output === 'string'
      ? output
      : (output?.formatted_output ?? output?.stdout ?? output?.output ?? output?.content ?? '')
  const exit = output?.exit_code ?? output?.exitCode
  return {
    status: body.status ?? '?',
    kind: body.kind ?? '?',
    command: String(command),
    exit,
    text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
    truncated: body.truncated === true
  }
}

// Options may follow the positionals: --session <key>, --limit <n>, --seq <n>, --raw.
function parseOptions(args) {
  const positional = []
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--raw') options.raw = true
    else if (arg === '--tail') options.tail = true
    else if (arg === '--session' || arg === '--limit' || arg === '--seq') {
      const value = args[++i]
      if (value === undefined) fail(`${arg} needs a value`)
      if (arg === '--session') options.session = value
      else {
        // A malformed selector must not become NaN → NULL → "no filter": that would reopen the one-row gate.
        const n = /^\d+$/.test(value) ? Number(value) : NaN
        if (!Number.isSafeInteger(n) || n < 1) fail(`${arg} needs a positive integer, got ${JSON.stringify(value)}`)
        options[arg.slice(2)] = n
      }
    } else if (arg.startsWith('--')) fail(`unknown option ${arg}`)
    else positional.push(arg)
  }
  return { positional, options }
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === 'leaf') {
    if (!rest[0]) fail(USAGE)
    console.log(leaf(rest[0]))
    return
  }
  if (!rest[0]) fail(USAGE)
  const db = open(rest[0])
  if (command === 'sessions') {
    const needle = rest[1] ?? null
    const rows = db
      .prepare(
        `select key, agentId, platform, channel, thread, sessionId, acpSessionId, state, executorDaemonId, stayedHomeReason,
                lastTurnOutcome, workspaceIsolation, birthStrategy, observedRuntime, observedModel, updatedAt
         from sessions
         where ?1 is null or key like '%' || ?1 || '%' or sessionId like '%' || ?1 || '%' or acpSessionId like '%' || ?1 || '%'
         order by updatedAt desc limit 50`
      )
      .all(needle)
    printJson(rows.map((row) => ({ ...row, updatedAt: isoIfEpoch(row.updatedAt), leaf: leaf(row.key) })))
    return
  }
  if (command === 'tools') {
    const { positional, options } = parseOptions(rest.slice(1))
    const [channel, thread] = positional
    if (!channel) fail(USAGE)
    if (options.raw && options.seq === undefined) fail('--raw shows one row at a time: pass --seq <n> with it')
    // Rows of one thread are shared by every agent in it; sessionScope is the admitting session's key.
    const filter = `channel = ?1 and (?2 is null or thread = ?2) and kind = 'tool'
           and (?3 is null or sessionScope = ?3) and (?4 is null or seq = ?4)`
    const params = [channel, thread ?? null, options.session ?? null, options.seq ?? null]
    const total = db.prepare(`select count(*) as n from transcript where ${filter}`).get(...params).n
    const limit = options.limit ?? 200
    const rows = db
      .prepare(
        `select seq, ts, sender, sessionScope, text, body from transcript
         where ${filter} order by seq ${options.tail ? 'desc' : 'asc'} limit ?5`
      )
      .all(...params, limit)
    if (options.tail) rows.reverse()
    let failed = 0
    let firstFailed
    for (const row of rows) {
      const tool = describeTool(row)
      const isFailed = tool.status === 'failed' || (tool.exit !== undefined && tool.exit !== 0)
      if (isFailed) {
        failed += 1
        firstFailed ??= row.seq
      }
      const marks = [
        isFailed ? 'FAIL' : 'ok',
        tool.text === '' ? 'no-output' : null,
        tool.truncated ? 'truncated' : null
      ]
        .filter(Boolean)
        .join(',')
      const scope = row.sessionScope ? leaf(row.sessionScope) : '-'
      console.log(
        `#${row.seq} ${row.ts ?? '-'} ${row.sender} ${scope} ${tool.kind} [${marks}] exit=${tool.exit ?? '-'}`
      )
      if (!options.raw) continue
      console.log(`    command: ${tool.command.replace(/\s+/g, ' ').slice(0, 500)}`)
      const head = tool.text.replace(/\s+/g, ' ').slice(0, 500)
      if (head) console.log(`    output:  ${head}`)
      else if (isFailed) console.log("    output:  (empty: read the runtime's own log under the session HOME)")
    }
    // A window that is not the whole set must say so, or "0 failed" reads as a verdict on the session.
    const window =
      rows.length < total
        ? ` (${options.tail ? 'newest' : 'oldest'} ${rows.length} of ${total}; ${options.tail ? 'earlier' : 'later'} rows not shown, raise --limit or use --tail)`
        : ''
    console.log(
      `\n${rows.length} tool rows${window}, ${failed} failed${firstFailed === undefined ? '' : `, first failure in window at seq ${firstFailed}`}`
    )
    if (!options.raw && failed > 0) console.log('command and output of one row: --seq <n> --raw (treat as sensitive)')
    return
  }
  if (command === 'query') {
    const [, sql, ...params] = rest
    if (!sql) fail(USAGE)
    printJson(db.prepare(sql).all(...params))
    return
  }
  fail(USAGE)
}

main(process.argv.slice(2))
