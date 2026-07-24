/**
 * `http/plugins/zod.ts` (design §2.1) — wires `fastify-type-provider-zod` so
 * routes declare zod schemas for params/body/response and Fastify validates &
 * serializes through them (the C2 DTO seam — these are REST DTOs, NOT the wire
 * protocol).
 *
 * The control-plane carries `bigint` fencing counters (`sessionEpoch`, …). JSON
 * has no bigint, and the default serializer throws on one, so the serializer is
 * built with a `replacer` that coerces any stray `bigint` to a JSON number. DTO
 * schemas should still map bigint → number explicitly; this is the safety net.
 */
import type { FastifyInstance } from 'fastify'
import { validatorCompiler, createSerializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'

/** Coerce bigint → number for JSON output (fencing epochs are well within 2^53). */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value
}

/** A Fastify instance narrowed to the zod type provider. */
export type ZodApp = FastifyInstance & {
  withTypeProvider: FastifyInstance['withTypeProvider']
}

/**
 * Install the zod validator + (bigint-safe) serializer compilers on `app`.
 * Call once on the root instance; child plugins inherit it.
 */
export function installZod(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(createSerializerCompiler({ replacer: bigintReplacer }))
}

export type { ZodTypeProvider }
