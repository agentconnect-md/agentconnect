/**
 * The SQLite→PostgreSQL dialect layer: statement rewrites, parameter binding, canonical
 * column-case restoration, and the PRAGMA/`sqlite_master` emulation `LocalStore` relies on.
 *
 * `LocalStore` writes SQLite-flavored SQL for both backends, so this module is the only place
 * that knows the two dialects differ. It is shared verbatim by the worker bridge and the
 * main-thread `PostgresAsyncDatabase` — one implementation, so the two paths cannot drift.
 */

// Stored schema name — the pool's data lives here, so the literal outlives the vocabulary rename.
export const POOL_STORE_SCHEMA = 'agentconnect_cloud_store'

/** Advisory-lock keys, held for the schema bootstrap and for each revision-bearing write. */
export const SCHEMA_LOCK_KEY = 'agentconnect-cloud-store-schema'
export const TRANSCRIPT_REVISION_LOCK_KEY = 'agentconnect-cloud-transcript-revision'

/** Every camelCase column and result alias `LocalStore` spells; an unlisted one reads back undefined. */
export const canonicalColumns = [
  'acpSessionId',
  'activationKey',
  'activeAt',
  'activeBytes',
  'activeCount',
  'agentCallDeliveryId',
  'agentId',
  'attachmentsJson',
  'attemptAt',
  'attemptId',
  'authorityGeneration',
  'authorityId',
  'automaticCount',
  'automaticWindowStartedAt',
  'backendOperationId',
  'callEnvelope',
  'callMeta',
  'capsJson',
  'channelId',
  'childSessionId',
  'claimedAt',
  'claimedBy',
  'completedAt',
  'connectionId',
  'connectionRevision',
  'conversationId',
  'conversationKind',
  'correlationId',
  'cpPrivate',
  'cpRev',
  'createdAt',
  'credentialEpoch',
  'daemonId',
  'defaultModel',
  'defaultPermissionMode',
  'deliveryReason',
  'dispatchId',
  'dreamId',
  'dueAt',
  'effortOverride',
  'endedAt',
  'enqueuedAt',
  'eventTimeUs',
  'executionSessionId',
  'expiresAt',
  'externalIntegrationId',
  'externalOriginJson',
  'externalProvider',
  'externalRealmKey',
  'externalResourceKey',
  'externalResourceKind',
  'failedAttempts',
  'fastModeOverride',
  'globalRules',
  'headSha',
  'hookContext',
  'hookId',
  'integrationId',
  'imageRef',
  'intentId',
  'introducedAt',
  'isIm',
  'isQueueCmd',
  'lastDeliveredTs',
  'lastRunAt',
  'lastTurnOutcome',
  'launchCorrelationId',
  'localExcluded',
  'loopGuardCounted',
  'mainAgentId',
  'mainSessionKey',
  'manifestDigest',
  'memoryProvider',
  'mergeRequestIid',
  'mintedAt',
  'modelId',
  'modelOverride',
  'modelsHash',
  'needsParentReply',
  'nextAttemptAt',
  'noteId',
  'observedAt',
  'observedModel',
  'observedModelSet',
  'oldestActiveAt',
  'operationId',
  'orchestrationId',
  'organizationSuggestions',
  'orgId',
  'originSessionId',
  'ownerId',
  'outputModeOverride',
  'parentId',
  'payloadBytes',
  'payloadHash',
  'permissionModeOverride',
  'permissionModes',
  'platformMessageId',
  'pluginId',
  'postId',
  'posterPublishState',
  'profileId',
  'probedAt',
  'projectId',
  'projectionId',
  'projectionKey',
  'providerCheckpoint',
  'purgedAt',
  'queuedAt',
  'quoteJson',
  'reasonCode',
  'replyTarget',
  'reportClaimedAt',
  'reportOwnerId',
  'requesterId',
  'requesterName',
  'recoveryAt',
  'resolvedAt',
  'retractedAt',
  'revision',
  'routingEpoch',
  'runtimeId',
  'scopeKey',
  'sessionKey',
  'sessionId',
  'sessionIds',
  'seededAt',
  'snapshotDigest',
  'snapshotWrites',
  'sourceBindingKind',
  'spaceId',
  'statusBarTs',
  'stopReason',
  'terminalAt',
  'terminalReport',
  'tenantScope',
  'threadUrl',
  'toAgentId',
  'toolCallId',
  'touchedAt',
  'totalCount',
  'transportScope',
  'transcriptCoordinates',
  'trustedAgentBot',
  'triggerKind',
  'triggeredBy',
  'trippedAt',
  'turnId',
  'updatedAt',
  'windowStartedAt',
  'workspaceIsolation',
  'writeMarker'
] as const

/** Lower-cased column name → the camelCase spelling every row shape expects back. */
export const columnNames: Record<string, string> = Object.fromEntries(
  canonicalColumns.map((name) => [name.toLowerCase(), name])
)

export interface BoundStatement {
  sql: string
  values: unknown[]
  /** 1-based `$n` slot carrying `revision`, when the statement writes one. */
  revisionSlot: number | undefined
}

/** SQLite constructs PostgreSQL spells differently; `INSERT OR IGNORE` becomes a conflict clause. */
export function rewrite(sql: string): string {
  let out = sql
    // PostgreSQL has no SQLite exclusive-writer transaction, so IMMEDIATE is dropped: a
    // shared-store statement must be a CAS or a relative write, never a read-then-write.
    .replace(/BEGIN\s+IMMEDIATE/gi, 'BEGIN')
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/length\(CAST\(([^)]+)\s+AS\s+BLOB\)\)/gi, 'octet_length($1::text)')
    .replace(/([A-Za-z_][A-Za-z0-9_.]*)\s+NOT\s+IN\s*\(\s*\)/gi, 'TRUE')
    .replace(/LIMIT\s+-1\s+OFFSET/gi, 'OFFSET')
    .replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1')
  const ignored = /^\s*INSERT\s+OR\s+IGNORE\s+/i.test(out)
  if (ignored) {
    out = out.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, 'INSERT ')
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING')
  }
  return out
}

/** Turn `?` positional or `@name` named parameters into `$n`, then rewrite the statement. */
export function bind(sql: string, input: unknown[]): BoundStatement {
  const values: unknown[] = []
  let revisionSlot: number | undefined
  if (input.length === 0) return { sql: rewrite(sql), values, revisionSlot }
  if (input.length === 1 && input[0] && typeof input[0] === 'object' && !Array.isArray(input[0])) {
    const params = input[0] as Record<string, unknown>
    const slots = new Map<string, number>()
    sql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => {
      let slot = slots.get(name)
      if (!slot) {
        slot = values.push(params[name] === undefined ? null : params[name])
        slots.set(name, slot)
      }
      if (name === 'revision') revisionSlot = slot
      return `$${slot}`
    })
  } else {
    let index = 0
    sql = sql.replace(/\?/g, (_all, offset: number) => {
      const slot = values.push(input[index] === undefined ? null : input[index])
      index += 1
      if (/revision\s*=\s*$/i.test(sql.slice(0, offset))) revisionSlot = slot
      return `$${slot}`
    })
  }
  return { sql: rewrite(sql), values, revisionSlot }
}

/** A revision-bearing transcript write: the one statement shape that needs the revision sequence. */
export function isRevisionBearingWrite(bound: BoundStatement): boolean {
  return Boolean(bound.revisionSlot) && /^\s*(INSERT|UPDATE)\s+/i.test(bound.sql) && /\btranscript\b/i.test(bound.sql)
}

/** A statement PostgreSQL has no equivalent for: dropped, or answered from the emulation tables. */
export type EmulatedStatement =
  { kind: 'noop' } | { kind: 'run'; sql: string; values: unknown[] } | { kind: 'read'; sql: string; values: unknown[] }

/** Map SQLite's PRAGMA and `sqlite_master` surface onto the store's own bookkeeping objects. */
export function emulate(sql: string, schema: string): EmulatedStatement | undefined {
  if (/^\s*PRAGMA\s+journal_mode/i.test(sql)) return { kind: 'noop' }
  const setVersion = /^\s*PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(sql)
  if (setVersion) {
    return {
      kind: 'run',
      sql:
        'INSERT INTO _local_store_schema_version (singleton, version) VALUES (true, $1) ' +
        'ON CONFLICT (singleton) DO UPDATE SET version = excluded.version',
      values: [Number(setVersion[1])]
    }
  }
  if (/^\s*PRAGMA\s+user_version/i.test(sql)) {
    return {
      kind: 'read',
      sql: 'SELECT COALESCE(MAX(version), 0)::bigint AS user_version FROM _local_store_schema_version',
      values: []
    }
  }
  if (/sqlite_master/i.test(sql)) {
    return {
      kind: 'read',
      sql: "SELECT COUNT(*)::bigint AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name <> '_local_store_schema_version'",
      values: [schema]
    }
  }
  return undefined
}

/** The DDL every store database bootstraps with, before any `LocalStore` statement runs. */
export function schemaBootstrapStatements(schema: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `SET search_path TO ${schema}, pg_catalog`,
    'CREATE SEQUENCE IF NOT EXISTS _transcript_revision_seq',
    'CREATE TABLE IF NOT EXISTS _local_store_schema_version (' +
      'singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), version BIGINT NOT NULL)'
  ]
}

interface QueryResultShape {
  rows?: unknown[]
  rowCount?: number | null
}

/** Restore the camelCase column names PostgreSQL folded away, for one result or a multi-statement list. */
export function rowsOf(result: unknown): unknown[] {
  const last = Array.isArray(result) ? (result.at(-1) as QueryResultShape | undefined) : (result as QueryResultShape)
  const rows = last?.rows ?? []
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [columnNames[key] ?? key, value])
    )
  )
}

/** `changes` for one result or, for a multi-statement text, the last statement's. */
export function changesOf(result: unknown): number {
  const last = Array.isArray(result) ? (result.at(-1) as QueryResultShape | undefined) : (result as QueryResultShape)
  return last?.rowCount ?? 0
}
