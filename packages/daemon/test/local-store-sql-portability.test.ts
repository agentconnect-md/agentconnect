/**
 * The daemon pool runs every `local-store.ts` statement through `PostgresSyncDatabase`,
 * so a SQLite-only construct there is a production fault on the pool, not a style issue.
 * `store-postgres` catches one the moment a suite covers the statement; this check is the
 * cheap half — it reads the SQL text itself, so an uncovered statement still fails fast.
 *
 * Only constructs the pool worker does NOT rewrite are listed. `INSERT OR IGNORE`,
 * `BEGIN IMMEDIATE`, `INTEGER PRIMARY KEY AUTOINCREMENT`, `PRAGMA user_version`,
 * `sqlite_master`, `LIMIT -1 OFFSET` and `length(CAST(x AS BLOB))` are translated in
 * `postgres-store-worker.js#rewrite` and stay legal. Extend that list only by making a
 * construct portable in the SQL — never by teaching the worker another function name.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

const storeSource = fileURLToPath(new URL('../src/store/local-store.ts', import.meta.url))

/** A statement may opt out with this marker plus the reason, inside the SQL itself. */
const ALLOW_MARKER = '-- pg-portable-exempt:'

const SQL_SHAPED =
  /\b(SELECT|INSERT\s+INTO|INSERT\s+OR|UPDATE\s+|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/i

interface Fragment {
  line: number
  text: string
}

/** Every string/template literal in the file, with `${…}` holes cooked to a bind placeholder. */
function sqlFragments(): Fragment[] {
  const source = readFileSync(storeSource, 'utf8')
  const file = ts.createSourceFile(storeSource, source, ts.ScriptTarget.ESNext, true)
  const fragments: Fragment[] = []
  const push = (node: ts.Node, text: string): void => {
    if (!SQL_SHAPED.test(text)) return
    fragments.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push(node, node.text)
    else if (ts.isTemplateExpression(node))
      push(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ? '))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return fragments
}

/** `MAX(a, b)` is a scalar in SQLite and an aggregate arity error in PostgreSQL — see #1068. */
function scalarMinMax(sql: string): boolean {
  for (const match of sql.matchAll(/\b(MAX|MIN)\s*\(/gi)) {
    let depth = 1
    for (let i = match.index + match[0].length; i < sql.length && depth > 0; i += 1) {
      const char = sql[i]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      else if (char === ',' && depth === 1) return true
    }
  }
  return false
}

const CHECKS: Array<{ name: string; portable: string; hit: (sql: string) => boolean }> = [
  { name: 'two-argument MAX/MIN', portable: 'CASE, or GREATEST/LEAST', hit: scalarMinMax },
  { name: 'IFNULL', portable: 'COALESCE', hit: (sql) => /\bIFNULL\s*\(/i.test(sql) },
  { name: 'IIF', portable: 'CASE', hit: (sql) => /\bIIF\s*\(/i.test(sql) },
  {
    name: 'datetime/strftime/julianday/unixepoch',
    portable: 'store epoch numbers, as the schema already does',
    hit: (sql) => /\b(datetime|strftime|julianday|unixepoch)\s*\(/i.test(sql)
  },
  {
    name: 'INSERT OR REPLACE/ABORT/FAIL',
    portable: 'ON CONFLICT … DO UPDATE',
    hit: (sql) => /\bINSERT\s+OR\s+(REPLACE|ABORT|FAIL)\b/i.test(sql)
  },
  { name: 'GROUP_CONCAT', portable: 'string_agg', hit: (sql) => /\bGROUP_CONCAT\s*\(/i.test(sql) },
  { name: 'printf', portable: 'format, or build the string in TypeScript', hit: (sql) => /\bprintf\s*\(/i.test(sql) },
  { name: 'TYPEOF', portable: 'a typed column', hit: (sql) => /\bTYPEOF\s*\(/i.test(sql) },
  { name: '|| concatenation', portable: 'CONCAT, or concatenate in TypeScript', hit: (sql) => sql.includes('||') },
  { name: 'comma LIMIT offset', portable: 'LIMIT … OFFSET …', hit: (sql) => /\bLIMIT\s+[@?$:]?\w+\s*,/i.test(sql) }
]

describe('local-store SQL portability', () => {
  it('sees the SQL it is supposed to police', () => {
    // A parser regression that stopped finding statements would make every check below vacuous.
    expect(sqlFragments().length).toBeGreaterThan(100)
  })

  it('recognizes each construct it claims to police', () => {
    // Without this the whole check could rot into a set of patterns that match nothing.
    const samples: Record<string, string> = {
      'two-argument MAX/MIN': 'UPDATE t SET a = MAX(a, @b) WHERE k = @k',
      IFNULL: 'SELECT IFNULL(a, 0) AS a FROM t',
      IIF: 'SELECT IIF(a > 0, 1, 0) AS a FROM t',
      'datetime/strftime/julianday/unixepoch': "SELECT * FROM t WHERE at < datetime('now')",
      'INSERT OR REPLACE/ABORT/FAIL': 'INSERT OR REPLACE INTO t (k) VALUES (@k)',
      GROUP_CONCAT: 'SELECT GROUP_CONCAT(a) AS a FROM t',
      printf: "SELECT printf('%s', a) AS a FROM t",
      TYPEOF: 'SELECT TYPEOF(a) AS kind FROM t',
      '|| concatenation': "SELECT a || '-' || b AS k FROM t",
      'comma LIMIT offset': 'SELECT * FROM t LIMIT 10, 20'
    }
    for (const check of CHECKS) expect([check.name, check.hit(samples[check.name] ?? '')]).toEqual([check.name, true])
  })

  it('uses no SQLite-only construct the pool store cannot run', () => {
    const offences = sqlFragments().flatMap(({ line, text }) =>
      text.includes(ALLOW_MARKER)
        ? []
        : CHECKS.filter((check) => check.hit(text)).map(
            (check) => `local-store.ts:${line} uses ${check.name} — write ${check.portable} instead`
          )
    )
    expect(offences).toEqual([])
  })
})
