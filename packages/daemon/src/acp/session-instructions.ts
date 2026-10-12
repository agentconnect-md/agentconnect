import { z } from 'zod'

const airCapabilities = z.object({
  jetbrains: z.object({
    air: z.object({ version: z.literal(1), capabilities: z.array(z.string()) })
  })
})

// AIR custom instructions become native developer instructions in runtimes that advertise this extension.
export function customInstructionsSupported(initMeta: unknown): boolean {
  const parsed = airCapabilities.safeParse(initMeta)
  return parsed.success && parsed.data.jetbrains.air.capabilities.includes('customInstructions')
}

export function customInstructionsMeta(systemPrompt?: string, systemAppend?: string) {
  const instructions = [systemPrompt, systemAppend].filter(Boolean).join('\n\n')
  return instructions ? { jetbrains: { air: { version: 1, customInstructions: instructions } } } : undefined
}
