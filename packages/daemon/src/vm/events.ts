import { z } from 'zod'

/** A loopback port the helper bound, paired with the guest port it reaches. */
export const VmmForwardSchema = z.object({
  hostPort: z.number().int().positive(),
  guestPort: z.number().int().positive()
})

/** Emitted once the forwards are bound, so `forwards` carries dialable ports. NOT readiness: the
 *  guest is still booting, and readiness is the daemon's own successful shim bind. */
export const VmmBootingSchema = z.object({
  event: z.literal('booting'),
  vmmVersion: z.string().min(1),
  cpuCount: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  kernelCommandLine: z.string(),
  forwards: z.array(VmmForwardSchema),
  dataDisk: z.string().optional()
})

/** Separates a guest that stopped itself from one the daemon tore down, which is what decides
 *  whether an exit is a fault worth reporting rather than an expected suspension. */
export const VmmExitReasonSchema = z.enum(['guest-powered-off', 'guest-error', 'forced', 'start-failed'])

export const VmmExitedSchema = z.object({
  event: z.literal('exited'),
  code: z.number().int(),
  reason: VmmExitReasonSchema
})

export const VmmEventSchema = z.discriminatedUnion('event', [VmmBootingSchema, VmmExitedSchema])

export type VmmForward = z.infer<typeof VmmForwardSchema>
export type VmmBooting = z.infer<typeof VmmBootingSchema>
export type VmmExited = z.infer<typeof VmmExitedSchema>
export type VmmExitReason = z.infer<typeof VmmExitReasonSchema>
export type VmmEvent = z.infer<typeof VmmEventSchema>

/** Unknown lines are ignored rather than fatal: the helper also writes human warnings, and a newer
 *  helper may emit an event this daemon predates. */
export function parseVmmEvent(line: string): VmmEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = VmmEventSchema.safeParse(JSON.parse(trimmed))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
