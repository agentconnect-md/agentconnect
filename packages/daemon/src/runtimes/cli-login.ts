// Runtimes whose ACP `authenticate` cannot be finished from a headless client, and the login
// subcommand of their own CLI that can. An entry here is not a preference: it is a runtime that
// answers `authenticate` with silence, leaving the operator with nothing to act on.

import type { RuntimeDef } from '../config/config-schema.js'

interface CliLoginSpec {
  /** Only these method ids are redirected; anything else the runtime offers still goes over ACP. */
  methods: string[]
  /** The ACP-mode argv tail the launch ends with. Login is a different subcommand, so it replaces
   *  this rather than appending — and a launch that does not end in it is left to ACP untouched. */
  acpTail: string[]
  /** What takes the tail's place. */
  loginArgs: string[]
  /** One line telling the operator why their terminal is being handed to the runtime's own CLI. */
  reason: string
}

const CLI_LOGIN: Record<string, CliLoginSpec> = {
  // grok-build's inline flow silently tries to open a browser ON THE DAEMON HOST and then waits
  // forever: no elicitation, nothing on stderr, and no loopback listener for the redirect-paste
  // fallback to reach. `grok login --device-auth` prints a URL and a code, and writes the same
  // ~/.grok/auth.json that sessions are seeded from.
  'grok-build': {
    methods: ['grok.com'],
    acpTail: ['agent', 'stdio'],
    loginArgs: ['login', '--device-auth'],
    reason: 'grok-build cannot run this login over ACP — handing your terminal to `grok login --device-auth`.'
  }
}

export interface CliLoginLaunch {
  /** The interactive launch, spawned exactly like a `terminal` method's. */
  runtime: RuntimeDef
  reason: string
}

/** The CLI login that logs `runtimeId` in, or undefined when ACP `authenticate` is the way. */
export function cliLoginLaunch(runtimeId: string, methodId: string, runtime: RuntimeDef): CliLoginLaunch | undefined {
  const spec = CLI_LOGIN[runtimeId]
  if (!spec?.methods.includes(methodId)) return undefined
  const head = runtime.args.slice(0, runtime.args.length - spec.acpTail.length)
  const tail = runtime.args.slice(head.length)
  if (tail.length !== spec.acpTail.length || tail.some((arg, i) => arg !== spec.acpTail[i])) return undefined
  return { runtime: { ...runtime, args: [...head, ...spec.loginArgs] }, reason: spec.reason }
}
