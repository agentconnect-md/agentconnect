import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
  AuthMethod,
  AuthMethodTerminal,
  CreateElicitationRequest,
  CreateElicitationResponse
} from '@agentclientprotocol/sdk'
import { AcpHost } from '../acp/acp-host.js'
import { loadConfig } from '../config/load-config.js'
import { resolveRoot } from '../paths.js'
import { ArchiveStore, parseArchiveLaunch, storedArchiveRuntimeDef } from '../runtimes/archive-store.js'
import { cliLoginLaunch } from '../runtimes/cli-login.js'
import { installedRuntimeCatalog } from '../runtimes/probe.js'
import { probeAllRuntimes, type RuntimeProbeResult } from '../runtimes/runtime-prober.js'
import { defaultProbeHostFactory } from '../acp/probe-host-factory.js'
import { fixedRows, pickRow, type PickerIo, type PickerModel, type PickerRow } from './auth-picker.js'
import {
  CLI_ELICIT_SURFACE,
  elicitFieldLabel,
  elicitForm,
  elicitFormAccepts,
  elicitFormContent,
  elicitRequiredProps,
  fieldAccepts,
  type ElicitTarget
} from '../slack/render.js'
import { resolveRuntimeCatalog, type ResolvedRuntimeCatalog } from '../runtimes/registry.js'
import type { RuntimeDef } from '../config/config-schema.js'

/**
 * Interactive login for one runtime, run by the operator ON the daemon host.
 *
 * ACP gives an agent two ways to be logged in, and both need a human at a terminal, which is why
 * this is a CLI command and not something the daemon can do for itself:
 *
 *  - `terminal` methods: the CLIENT re-launches the agent program as an interactive process (with
 *    the method's extra args/env) and a zero exit means success. Agents may only offer these when
 *    the client advertises `auth.terminal`, so a daemon session never sees them — this command does.
 *  - `agent` methods (the default when a method carries no `type`): the agent runs its own flow
 *    behind `authenticate`, asking through URL/form elicitation, or simply printing to its stderr.
 *
 * The runtime deliberately runs UNSANDBOXED against the operator's own HOME, exactly as if they had
 * run its CLI by hand: the credential must land in the host state dir that RUNTIME_STATE_LOCATIONS
 * seeds sessions FROM. A private-HOME launch would write the login into a directory that is thrown
 * away with the process.
 */
export interface RunAuthOpts {
  runtimeId?: string
  methodId?: string
  configPath?: string
  root?: string
  out?: NodeJS.WritableStream
  /** Test seams; production resolves the real catalog and spawns a real AcpHost. */
  resolveCatalog?: () => Promise<ResolvedRuntimeCatalog>
  installed?: (catalog: ResolvedRuntimeCatalog) => ResolvedRuntimeCatalog
  hostFactory?: (runtime: RuntimeDef, options: ConstructorParameters<typeof AcpHost>[1]) => AcpHost
  /** Test seam for the client-run `terminal` method; production spawns it on the real TTY. */
  runTerminalAuth?: (runtime: RuntimeDef, method: AuthMethod) => Promise<number>
  /** Test seams for the loopback-paste fallback: reading a line, and replaying the pasted URL.
   *  An aborted `signal` must release a question already waiting on stdin, answering empty. */
  readLine?: (question: string, signal?: AbortSignal) => Promise<string>
  deliverLoopback?: (url: string) => Promise<void>
  /** How long to let an agent-run login settle before offering the paste fallback. */
  pasteAfterMs?: number
  /** Skip the login-state sweep and list every installed runtime in one group. */
  skipProbe?: boolean
  /** Test seams for the grouped picker. */
  probeRuntimes?: typeof probeAllRuntimes
  pick?: (model: PickerModel, io: PickerIo, prompt: string) => Promise<string | undefined>
  io?: PickerIo
}

function isTerminalMethod(method: AuthMethod): method is AuthMethodTerminal & { type: 'terminal' } {
  return 'type' in method && method.type === 'terminal'
}

/** Row detail for one login method: what it is, and who runs it. */
function hintFor(method: AuthMethod): string {
  const kind = isTerminalMethod(method) ? 'in a terminal' : 'handled by the runtime'
  return `${method.description?.trim() || method.name} (${kind})`
}

/** Ask one line. An abort resolves it empty and closes the interface: a login that settles while
 *  the operator is being prompted must not stay parked on stdin waiting for a keypress. */
async function readLine(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<string>((resolve) => {
      if (signal?.aborted) return resolve('')
      onAbort = () => resolve('')
      signal?.addEventListener('abort', onAbort, { once: true })
      rl.question(question, resolve)
    })
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    rl.close()
  }
}

/** Re-launch the agent program interactively on the operator's own terminal. */
function spawnTerminalAuth(runtime: RuntimeDef, method: AuthMethod): Promise<number> {
  const extra = isTerminalMethod(method) ? { args: method.args, env: method.env } : {}
  const args = [...runtime.args, ...(extra.args ?? [])]
  const env = {
    ...process.env,
    ...Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value])),
    ...(extra.env ?? {})
  }
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * List the installed runtimes at once, then annotate each with whether it is logged in FOR THIS
 * OPERATOR as the verdicts arrive.
 *
 * The order is fixed the moment the list appears and never changes: the sweep launches every
 * runtime and answers over tens of seconds, so a verdict lands as a status on its own row rather
 * than moving it. A selection made before any verdict is honoured immediately.
 *
 * The status is a real probe, not a guess: nothing persists it (the daemon's `authRequired` lives
 * in its process, and its local store caches only model catalogs), and every on-disk heuristic
 * misreads a runtime that authenticates from an env var. The sweep runs the way this command logs
 * in — host HOME, unsandboxed — so "logged in" answers the question actually being asked.
 */
async function chooseRuntime(
  catalog: ResolvedRuntimeCatalog,
  root: string,
  opts: RunAuthOpts,
  out: NodeJS.WritableStream
): Promise<string | undefined> {
  const ids = Object.keys(catalog.entries).sort()
  if (ids.length === 0) throw new Error('no runtimes are installed on this host')
  const io = opts.io ?? { input: process.stdin, output: process.stdout }
  const pick = opts.pick ?? pickRow
  const rowFor = (id: string, hint?: string): PickerRow => ({
    id,
    ...(catalog.entries[id]?.name ? { name: catalog.entries[id]!.name } : {}),
    ...(hint ? { hint } : {})
  })

  if (opts.skipProbe) {
    return pick(fixedRows(ids.map((id) => rowFor(id))), io, 'Select a runtime to log in')
  }

  const results = new Map<string, RuntimeProbeResult>()
  const listeners = new Set<() => void>()
  const statusFor = (id: string): string => {
    const result = results.get(id)
    if (!result) return 'checking…'
    if (result.ok) {
      const models = result.models.length > 0 ? `${result.models.length} model(s)` : 'no models offered'
      return `logged in — ${result.probedVersion ? `${models}, ${result.probedVersion}` : models}`
    }
    if (result.authRequired) return 'not logged in'
    return `not logged in — ${result.error ? result.error.slice(0, 60) : 'probe failed'}`
  }
  const model: PickerModel = {
    rows: () => ids.map((id) => rowFor(id, statusFor(id))),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  // Aborted the moment a runtime is chosen: nothing new is launched and every probe in flight
  // ends at once (runtime-prober races the signal), which is what makes the teardown below cheap
  // to wait for. The sweep is never awaited BEFORE a choice — that delay is what this list exists
  // to avoid.
  const sweep = new AbortController()
  const probe = opts.probeRuntimes ?? probeAllRuntimes
  const running = probe(Object.fromEntries(ids.map((id) => [id, catalog.entries[id]!.runtime])), {
    hostFactory: defaultProbeHostFactory({}),
    hostEnv: process.env,
    signal: sweep.signal,
    // The store owns an archive runtime's binary; probe what a login would actually launch.
    resolveRuntime: async (id, runtime) => {
      const entry = catalog.entries[id]
      const archive = entry ? parseArchiveLaunch(id, entry) : undefined
      if (!archive) return runtime
      return storedArchiveRuntimeDef(runtime, await new ArchiveStore({ root }).ensure(archive))
    },
    onResult: (result) => {
      results.set(result.runtime, result)
      for (const listener of listeners) listener()
    }
  })
  running.catch((err) => out.write(`login check failed: ${(err as Error).message}\n`))

  try {
    return await pick(model, io, 'Select a runtime to log in')
  } finally {
    // Cancelled AND awaited: these probes are children of THIS process, and the CLI action exits
    // as soon as runAuth resolves, so a teardown nobody waited for leaves them running after the
    // command is gone. The abort ends each in-flight probe at once rather than at its deadline,
    // so waiting for it costs the operator nothing measurable.
    sweep.abort()
    await running.catch(() => undefined)
  }
}

// Long enough for a runtime to notice stdin EOF and exit on its own (Antigravity's ACP server
// takes ~620ms), short enough that a wedged one still gets signalled promptly.
const EOF_GRACE_MS = 2500

/** A loopback redirect the operator may replay locally: http(s) to 127.0.0.1/localhost, with a port. */
function loopbackRedirect(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return undefined
  if (url.username || url.password) return undefined
  return url
}

/**
 * Offer to finish a loopback OAuth login without a port forward.
 *
 * Google retired the copy/paste (OOB) flow in January 2023 and pointed desktop clients at the
 * loopback IP flow instead, so a runtime like Antigravity binds an HTTP server to 127.0.0.1 on the
 * DAEMON host and waits for the browser to be redirected there. On a headless host the browser
 * cannot reach it — but the redirect still happens, and the full `?code=…&state=…` URL is sitting
 * in the address bar of the tab that failed to load. Replaying that URL from this process, which
 * does run on the daemon host, hands the code to the waiting listener.
 *
 * Resolves as soon as the login settles; the prompt is only offered while it is still pending, so a
 * login completed through a port forward (or one that needed no browser at all) never sees it.
 */
async function offerLoopbackPaste(login: Promise<void>, opts: RunAuthOpts, out: NodeJS.WritableStream): Promise<void> {
  const ask = opts.readLine ?? readLine
  const deliver =
    opts.deliverLoopback ??
    (async (url: string) => {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      // Any answer means the listener took the request; its body is a browser page, not our business.
      if (res.status >= 500) throw new Error(`the local listener answered HTTP ${res.status}`)
    })

  // The prompt is racing the login itself, so it gets a signal rather than a flag: a resolved
  // login has to close the readline question, which no amount of polling `settled` can do.
  let settled = false
  const done = new AbortController()
  const finish = (): void => {
    settled = true
    done.abort()
  }
  void login.then(finish, finish)
  await Promise.race([login.catch(() => undefined), new Promise((r) => setTimeout(r, opts.pasteAfterMs ?? 3000))])
  if (settled) return

  out.write('\nIf the browser could not reach the redirect (this host is headless, no port forward),\n')
  out.write('copy the URL of the tab that failed to load and paste it here — it carries the code.\n')
  while (!settled) {
    const answer = (await ask('\nRedirect URL (Enter to keep waiting): ', done.signal)).trim()
    if (settled || answer === '') return
    const url = loopbackRedirect(answer)
    if (!url) {
      out.write('That is not a loopback redirect URL (expected http://127.0.0.1:<port>/…). Ignored.\n')
      continue
    }
    try {
      await deliver(url.toString())
      out.write('Delivered to the local listener; waiting for the runtime to finish…\n')
      return
    } catch (err) {
      out.write(`Could not reach the local listener: ${(err as Error).message}\n`)
    }
  }
}

/** Split a typed multi-select answer into the values the schema will be checked against. */
function splitValues(line: string): string[] {
  return line
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

/** The most times one field is re-asked before it is left unanswered — a typo deserves another
 *  go, an operator who cannot satisfy the schema deserves to be let out of the loop. */
const FIELD_ATTEMPTS = 3

/**
 * Ask one reduced field on the terminal, or return undefined when it was left unanswered.
 *
 * The pickable kinds are chosen from the options the AGENT offered, so a typo cannot invent a
 * value it never asked for; text, number and multi-select are typed and re-asked while the
 * field's own schema refuses them ({@link fieldAccepts} — the same gate the answer is checked
 * against, applied here so the refusal is explainable rather than a late blanket decline).
 */
async function askField(
  target: ElicitTarget,
  label: string,
  opts: RunAuthOpts,
  out: NodeJS.WritableStream
): Promise<string | number | string[] | undefined> {
  if (target.kind === 'enum' || target.kind === 'boolean') {
    const io = opts.io ?? { input: process.stdin, output: process.stdout }
    const rows = target.options.map((option) => ({ id: option.value, name: option.label }))
    return await (opts.pick ?? pickRow)(fixedRows(rows), io, label)
  }

  const ask = opts.readLine ?? readLine
  if (target.kind === 'multi-enum') {
    out.write(`\n${label} — one or more of: ${target.options.map((option) => option.value).join(', ')}\n`)
  } else {
    out.write(`\n${label}\n`)
  }
  const prompt = target.kind === 'multi-enum' ? 'Values (comma-separated, empty to skip): ' : 'Value (empty to skip): '
  for (let attempt = 0; attempt < FIELD_ATTEMPTS; attempt++) {
    const line = (await ask(prompt)).trim()
    if (line === '') return undefined
    const value = target.kind === 'multi-enum' ? splitValues(line) : target.kind === 'number' ? Number(line) : line
    if (fieldAccepts(target, value)) return value
    out.write(`That is not a value ${target.propName} accepts.\n`)
  }
  return undefined
}

/**
 * Answer a form elicitation with the properties the agent's own `requestedSchema` asked for.
 *
 * The reduction is the shared one — {@link elicitForm} over {@link CLI_ELICIT_SURFACE} — so this
 * terminal answers under the schema's own property names and types, and a form carrying a
 * required field it cannot render is declined whole rather than half-answered. An accept keyed
 * on anything else (a fixed `{type,text}`, say) is an answer the runtime never asked for: a
 * request for `projectId` would come back without one and the login would fail on it.
 */
async function answerAuthForm(
  params: CreateElicitationRequest,
  opts: RunAuthOpts,
  out: NodeJS.WritableStream
): Promise<CreateElicitationResponse | undefined> {
  const form = elicitForm(params, CLI_ELICIT_SURFACE)
  if (!form) {
    out.write('\nThe runtime asked for input this terminal cannot render whole — declining.\n')
    return undefined
  }
  const message = (params as { message?: unknown }).message
  if (typeof message === 'string' && message.trim()) out.write(`\n${message.trim()}\n`)

  const answer: Record<string, string | number | string[]> = {}
  for (const target of form) {
    const value = await askField(target, elicitFieldLabel(params, target.propName), opts, out)
    if (value !== undefined) answer[target.propName] = value
  }
  // Nothing typed is a decline, not an empty accept: the spec has agents handle `decline`, and
  // an empty accept would report "answered" for a question the operator walked away from.
  if (Object.keys(answer).length === 0) return undefined
  if (!elicitFormAccepts(form, elicitRequiredProps(params), answer)) {
    out.write('\nDeclined — the runtime needs every required field answered.\n')
    return undefined
  }
  return { action: 'accept', content: elicitFormContent(form, answer) } as CreateElicitationResponse
}

export async function runAuth(opts: RunAuthOpts): Promise<void> {
  const out = opts.out ?? process.stdout
  const root = resolveRoot(opts.root)
  const cfg = loadConfig({ root: opts.root, configPath: opts.configPath, optional: true })

  const resolved = opts.resolveCatalog
    ? await opts.resolveCatalog()
    : await resolveRuntimeCatalog(cfg, root, {
        ...(opts.runtimeId ? { neededRuntimes: [opts.runtimeId] } : {}),
        mode: 'cache-first'
      })
  const catalog = opts.installed ? opts.installed(resolved) : installedRuntimeCatalog(resolved)

  const runtimeId = opts.runtimeId ?? (await chooseRuntime(catalog, root, opts, out))
  if (!runtimeId) return

  const entry = catalog.entries[runtimeId]
  if (!entry) {
    const ids = Object.keys(catalog.entries).sort().join(', ') || '(none)'
    throw new Error(`runtime "${runtimeId}" is not installed on this host. Available: ${ids}`)
  }

  // Same store the daemon launches from: a vendor-archive runtime is not launchable until it is
  // extracted, and a login against a different binary than the sessions run would be a lie.
  const archive = parseArchiveLaunch(runtimeId, entry)
  const runtime = archive
    ? storedArchiveRuntimeDef(
        entry.runtime,
        await new ArchiveStore({
          root,
          log: { info: (message) => out.write(`${message}\n`), warn: (message) => out.write(`${message}\n`) }
        }).ensure(archive)
      )
    : entry.runtime

  const hostOptions: ConstructorParameters<typeof AcpHost>[1] = {
    onUpdate: () => {},
    runtimeId: runtimeId,
    isolateAccountApps: cfg.security.isolateAccountApps,
    authTerminalCapable: true,
    // The agent's own flow speaks through these two channels, and its stderr — which stays
    // unsuppressed here, because a runtime that prints a consent link has nowhere else to put it.
    onAuthElicit: async (params: CreateElicitationRequest): Promise<CreateElicitationResponse | undefined> => {
      const url = (params as { url?: unknown }).url
      if (typeof url === 'string') {
        out.write(`\nOpen this URL to continue signing in:\n\n  ${url}\n\n`)
        out.write('Waiting for the runtime to confirm…\n')
        return { action: 'accept' } as CreateElicitationResponse
      }
      return await answerAuthForm(params, opts, out)
    }
  }
  const host = opts.hostFactory ? opts.hostFactory(runtime, hostOptions) : new AcpHost(runtime, hostOptions)

  const onSigint = (): void => {
    void host.stop(5000, EOF_GRACE_MS).finally(() => process.exit(130))
  }
  process.once('SIGINT', onSigint)
  try {
    out.write(`Starting ${runtimeId}…\n`)
    await host.start()
    const methods = host.authMethods()
    if (methods.length === 0) {
      out.write(`${runtimeId} advertises no login methods — it either needs none or reads a credential from env.\n`)
      return
    }

    let method = opts.methodId ? methods.find((m) => m.id === opts.methodId) : undefined
    if (opts.methodId && !method) {
      throw new Error(
        `"${opts.methodId}" is not offered by ${runtimeId}. Offered: ${methods.map((m) => m.id).join(', ')}`
      )
    }
    if (!method) {
      if (methods.length === 1) method = methods[0]!
      else {
        // The same arrow-key list the runtime was chosen from: a login is no place to make someone
        // retype an identifier they can already see.
        const rows = methods.map((entry) => ({ id: entry.id, name: entry.name, hint: hintFor(entry) }))
        const answer = await (opts.pick ?? pickRow)(
          fixedRows(rows),
          opts.io ?? { input: process.stdin, output: process.stdout },
          `How do you want to log in to ${runtimeId}?`
        )
        if (!answer) return
        method = methods.find((m) => m.id === answer)
        if (!method) throw new Error(`"${answer}" is not one of the offered methods`)
      }
    }
    out.write(`Using ${method.id} — ${method.name}\n`)

    // A runtime that cannot finish this login over ACP is driven through its own CLI instead —
    // same handover as a `terminal` method, on a launch that names the login subcommand.
    const cli = cliLoginLaunch(runtimeId, method.id, runtime)
    if (isTerminalMethod(method) || cli) {
      // The client owns this one: hand the operator's terminal to the agent program itself.
      if (cli) out.write(`${cli.reason}\n`)
      await host.stop(5000, EOF_GRACE_MS)
      const code = await (opts.runTerminalAuth ?? spawnTerminalAuth)(cli?.runtime ?? runtime, method)
      if (code !== 0) throw new Error(`interactive login exited with code ${code}`)
    } else {
      const login = host.authenticate(method.id)
      await offerLoopbackPaste(login, opts, out)
      await login
    }

    out.write(`\n✓ ${runtimeId} is logged in on this host.\n`)
    out.write('Sessions pick the credential up on their next start — the daemon needs no restart.\n')
  } finally {
    process.removeListener('SIGINT', onSigint)
    // Graceful: a runtime that exits on stdin EOF then prints nothing. Some (Antigravity's ACP
    // server) install a signal handler that dumps a full stack trace over the operator's terminal
    // on SIGTERM, which reads like a crash right after a login that in fact succeeded.
    await host.stop(5000, EOF_GRACE_MS).catch(() => undefined)
  }
}
