/**
 * The documented self-host deployment enumerates each service's environment, so
 * a new variable is silently absent there even when the code reads it. This pins
 * the one that has to reach BOTH services to stay consistent.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const compose = readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8')

/** The `environment:` entries of one compose service. */
function serviceEnv(name: string): string[] {
  const service = compose.split(new RegExp(`^  ${name}:$`, 'm'))[1]
  if (service === undefined) throw new Error(`service ${name} not found in compose.yaml`)
  const block = service.split(/^  \S/m)[0] ?? ''
  const env = block.split(/^ {4}environment:$/m)[1]
  if (env === undefined) throw new Error(`service ${name} has no environment block`)
  const entries = env.split(/^ {4}\S/m)[0] ?? ''
  return (entries.match(/^ {6}- ([A-Z0-9_]+)/gm) ?? []).map((line) => line.replace(/^ {6}- /, '').trim())
}

describe('compose.yaml service environment', () => {
  it('passes SOCIAL_PROVIDERS to both the control plane and the web console', () => {
    // Both processes read this same variable; one of them missing it means the
    // sign-in buttons and the server-side allowlist disagree.
    expect(serviceEnv('control-plane')).toContain('SOCIAL_PROVIDERS')
    expect(serviceEnv('web')).toContain('SOCIAL_PROVIDERS')
  })
})
