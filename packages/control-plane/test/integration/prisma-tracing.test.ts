/**
 * Prisma tracing is a `globalThis` handshake, not a module patch:
 * `@prisma/instrumentation` parks a tracing helper under
 * `V<major>_PRISMA_INSTRUMENTATION` and the `@prisma/client` runtime picks it up
 * only when the majors line up. Nothing in the type system checks that, and this
 * deployment runs the v7 queryCompiler with a driver adapter rather than the old
 * Rust engine — so a Prisma upgrade can silently turn the database half of every
 * trace back into the empty space it used to be, with no build or test failure.
 *
 * This file is the tripwire: it runs real queries through the pool's client and
 * asserts the spans actually come out, with the SQL attached and the parameters
 * left off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import type { ReadableSpan } from '@opentelemetry/sdk-trace'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildPrismaInstrumentation } from '../../src/observability.js'

const AGENT = 'a3333333-3333-4333-8333-333333333333'
const DAEMON = 'd3333333-3333-4333-8333-333333333333'
const SESSION = 'sess-prisma-tracing'

const exporter = new InMemorySpanExporter()
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
const instrumentation = buildPrismaInstrumentation()

beforeAll(() => {
  instrumentation.setTracerProvider(provider)
  instrumentation.enable()
})

afterAll(async () => {
  // The helper lives on globalThis, so leaving it installed would keep tracing
  // every other test file that shares this worker.
  instrumentation.disable()
  await provider.shutdown()
})

beforeEach(() => {
  exporter.reset()
})

const names = (): string[] => exporter.getFinishedSpans().map((span) => span.name)
const attr = (span: ReadableSpan, key: string): unknown => span.attributes[key]

describe('prisma opentelemetry instrumentation', () => {
  it('turns a read into spans that name the operation and carry its SQL', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, SESSION, AGENT)
    exporter.reset()

    await prisma.sessionMeta.findMany({ where: { orgId: DEFAULT_ORG_ID }, take: 5 })

    expect(names()).toContain('prisma:client:operation')
    expect(names()).toContain('prisma:client:db_query')

    const operation = exporter.getFinishedSpans().find((span) => span.name === 'prisma:client:operation')
    expect(attr(operation!, 'name')).toBe('SessionMeta.findMany')

    const query = exporter.getFinishedSpans().find((span) => span.name === 'prisma:client:db_query')
    expect(attr(query!, 'db.system.name')).toBe('postgresql')
    expect(String(attr(query!, 'db.query.text'))).toMatch(/select/i)
  })

  it('records the SQL template without the parameter values', async () => {
    // The whole point of naming SQL in a span is that it is the *shape* of the
    // query. Prisma passes bound values to the query event, not the span; if
    // that ever changes, every literal a caller filters on starts landing in the
    // trace store.
    const secret = 'do-not-export-this-literal'
    await prisma.sessionMeta.findMany({ where: { orgId: DEFAULT_ORG_ID, channel: secret } })

    const exported = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes))
    expect(exported).not.toContain(secret)
    expect(exported).toMatch(/select/i)
  })

  it('drops the serialize span the deployment configuration ignores', async () => {
    await prisma.sessionMeta.findMany({ where: { orgId: DEFAULT_ORG_ID } })

    // Anchored on a populated span set: asserting the absence alone would pass
    // just as well when the instrumentation emits nothing at all.
    expect(names()).toContain('prisma:client:db_query')
    expect(names()).not.toContain('prisma:client:serialize')
  })

  it('amortizes the compile span and settles at two spans per query', async () => {
    // A query shape used nowhere else in this file, so this call compiles it.
    const shape = { where: { phase: 'start' }, orderBy: { id: 'asc' } } as const
    await prisma.sessionMeta.findMany(shape)
    expect(names()).toContain('prisma:client:compile')

    exporter.reset()
    await prisma.sessionMeta.findMany(shape)

    // Prisma caches the compiled plan per shape, so `compile` does not scale
    // with traffic. Steady state is one `operation` plus one `db_query` per
    // call — the volume claim this change is merged on, pinned here so a future
    // Prisma release that adds a per-query span has to be an explicit decision
    // rather than a silent multiplier on the collector.
    expect(names().sort()).toEqual(['prisma:client:db_query', 'prisma:client:operation'])
  })

  it('spans a transaction so multi-statement work is attributable', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.sessionMeta.findMany({ where: { orgId: DEFAULT_ORG_ID } })
    })

    expect(names()).toContain('prisma:client:transaction')
    expect(names()).toContain('prisma:client:start_transaction')
    expect(names()).toContain('prisma:client:commit_transaction')
  })
})
