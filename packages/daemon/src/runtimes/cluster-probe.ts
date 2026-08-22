import { z } from 'zod'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { applyCodexSessionFloor, applyStaticModelConfig, modelProviderTarget } from './model-provider-config.js'
import type { ModelCredential, ModelRuntimeKind } from './model-provider-config.js'
import { probeRuntime, type ProbeHostFactory, type RuntimeProbeResult } from './runtime-prober.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from './k8s-runtimes.js'

/**
 * The `--k8s` runtime probe: launch each declared runtime IN the held probe sandbox, with the
 * deployment's provider credentials, and read the models it advertises.
 *
 * The image's own build-time table cannot answer this. It is generated with no credentials, so it
 * publishes no model list at all, and the daemon then advertises runtimes whose model pickers are
 * empty — the console's symptom. Credentials are the whole difference: they live on the daemon
 * (deployment env) and in the pod (the SandboxTemplate's `AC_*` fill-in), and a session opened
 * with them is what makes a runtime answer with its real catalog instead of `authRequired`.
 *
 * Serial on purpose. Every runtime here runs in ONE pod, and a probe is a background startup task
 * whose latency nobody waits on — concurrency would only multiply what a single sandbox is asked
 * to hold at once.
 */

/** Per-runtime budget: a pod round trip plus a gateway handshake, so double the host probe's. */
export const CLUSTER_PROBE_TIMEOUT_MS = 60_000
/** The rest of one member's sweep before the per-runtime sessions: a probe sandbox's cold boot,
 *  then the image's own table generation (the shim's `probe` request budget). */
const CLUSTER_PROBE_PREAMBLE_MS = 90_000 + 180_000
/** Runtimes one image is assumed at most to ship — the sessions are serial, so this is what turns
 *  the per-runtime budget into a whole-sweep ceiling. Today's image ships four. */
const CLUSTER_PROBE_MAX_RUNTIMES = 8

/**
 * Ceiling on ONE member's whole sweep. Both the claim's stale window and a waiting member's
 * patience derive from it, because they are the same question asked from two sides: a follower
 * that gives up before the holder's ceiling claims a sandbox of its own and spends exactly the
 * pods this election exists to save, and a claim that expires before it would hand the work to a
 * second prober while the first is still running.
 */
export const K8S_PROBE_SWEEP_CEILING_MS =
  CLUSTER_PROBE_PREAMBLE_MS + CLUSTER_PROBE_MAX_RUNTIMES * CLUSTER_PROBE_TIMEOUT_MS

export interface ClusterProbeOptions {
  /** Runtimes to probe — the admitted catalog, whose commands are the IMAGE's. */
  runtimes: Record<string, RuntimeDef>
  /** Identity that routes a launch into the held probe sandbox (`SpawnRequest.env.AC_AGENT_ID`). */
  agentId: string
  /** Session cwd in the POD's coordinates — its workspace mount, never a daemon path. */
  cwd: string
  hostFactory: ProbeHostFactory
  /** The deployment's provider pair for a runtime kind, when one is configured. */
  staticCredential?: (kind: ModelRuntimeKind) => ModelCredential | undefined
  /** Deployment-asserted codex session config, applied exactly as a real launch applies it. */
  codexSessionFloor?: string
  log?: Logger
  timeoutMs?: number
  /** Called as each runtime answers, so the console converges per runtime rather than at the end. */
  onResult?: (result: RuntimeProbeResult) => Promise<void> | void
}

/**
 * Stand-in key for a deployment whose model egress mints its keys per session: real launches ask
 * the key server, and a probe — which belongs to no session — has nothing to ask for.
 *
 * Codex and DeepSeek Harness refuse `session/new` outright with no credential, so an endpoint-only
 * deployment loses their whole model list to a credential the enumeration never spends: the probe
 * reads the session's model selector and never prompts. Advertising nothing is the worse answer,
 * because it also reads as "this runtime needs a login" in the console.
 */
export const PROBE_PLACEHOLDER_KEY = 'ac-runtime-probe-no-key'

/** The pair a probe launches with: the deployment's own, or its endpoint plus the stand-in. */
function probeCredential(configured: ModelCredential | undefined): ModelCredential | undefined {
  if (!configured || configured.key) return configured
  return configured.baseUrl ? { ...configured, key: PROBE_PLACEHOLDER_KEY } : configured
}

/**
 * The child environment one probed runtime launches with: provider configuration and the routing
 * id, and nothing else — the pod supplies HOME/PATH, and this daemon's env describes another
 * machine.
 *
 * Returns the credential values it wrote alongside it. A probe failure is sanitized against them
 * before it becomes a diagnostic, and the injected key is in none of the daemon-env names the
 * sanitizer knows: it comes from `*_MODEL_TOKEN`, and codex embeds it inside a whole
 * `DEFAULT_AUTH_REQUEST` blob. Without this an error quoting the child env would be logged AND
 * published into the pool's shared store.
 */
export function clusterProbeEnv(
  runtimeId: string,
  runtime: RuntimeDef,
  opts: Pick<ClusterProbeOptions, 'agentId' | 'staticCredential' | 'codexSessionFloor'>
): { env: Record<string, string>; redactValues: string[]; uncredentialed: boolean } {
  const env: Record<string, string> = { AC_AGENT_ID: opts.agentId }
  const target = modelProviderTarget({ runtime: runtimeId }, runtime)
  // A runtime with no provider surface carries its own auth, so nothing was withheld from it.
  if (!target) return { env, redactValues: [], uncredentialed: false }
  const configured = opts.staticCredential?.(target.runtime)
  const credential = probeCredential(configured)
  if (credential) applyStaticModelConfig(target, env, credential)
  // Last, so every key the daemon authored above stays authoritative over the floor — the same
  // order a real launch uses.
  if (opts.codexSessionFloor) applyCodexSessionFloor(target, env, opts.codexSessionFloor)
  const key = configured?.key
  // The key itself, plus every value it was folded into — matched by content rather than by
  // variable name, so a runtime that gains a new credential-bearing variable is covered already.
  const redactValues = key ? [key, ...Object.values(env).filter((value) => value !== key && value.includes(key))] : []
  return { env, redactValues, uncredentialed: !credential?.key }
}

export async function probeClusterRuntimes(opts: ClusterProbeOptions): Promise<RuntimeProbeResult[]> {
  const ids = Object.keys(opts.runtimes)
  const results: RuntimeProbeResult[] = []
  for (const id of ids) {
    const runtime = opts.runtimes[id]!
    const { env, redactValues, uncredentialed } = clusterProbeEnv(id, runtime, opts)
    const probed = await probeRuntime(id, runtime, opts.cwd, {
      ...(opts.log ? { log: opts.log } : {}),
      hostFactory: opts.hostFactory,
      timeoutMs: opts.timeoutMs ?? CLUSTER_PROBE_TIMEOUT_MS,
      // The pod is the isolation boundary AND a different filesystem: there is no private HOME to
      // compose here, and inheriting this daemon's environment would describe another machine.
      launchFor: () => ({ env, inheritProcessEnv: false, redactValues })
    })
    // Marked on the result rather than left to the caller, because an adopting member reads the
    // published result and has no other way to know what the prober launched with.
    const result = uncredentialed ? { ...probed, uncredentialed: true } : probed
    results.push(result)
    try {
      await opts.onResult?.(result)
    } catch (err) {
      // A reporting failure must never abort the remaining probes.
      opts.log?.warn(`probe: reporting ${id} failed: ${(err as Error).message}`)
    }
  }
  return results
}

/**
 * The pool-wide probe's published answer: what one member found, for every member on the same
 * runtime image to advertise.
 *
 * Published rather than repeated because the answer is about the IMAGE, not the member — the
 * daemon does not run these runtimes, the pod does, and a second member asking the same image the
 * same question can only get the same answer at the cost of another pod. Keyed on the image for
 * the same reason: a template bump is a different key, so no member is ever served a previous
 * image's models, which is the one thing a shared answer could otherwise get wrong.
 */
export interface K8sProbePayload {
  table: K8sRuntimeTable
  results: RuntimeProbeResult[]
}

/** How long the pool honours one member's claim before another may retake it, and how long a
 *  member waits on that holder — one number, so a waiting member gives up exactly when the claim
 *  it is waiting on becomes retakeable. A member that DIED is what the ceiling exists for. */
export const K8S_PROBE_CLAIM_TTL_MS = K8S_PROBE_SWEEP_CEILING_MS
export const K8S_PROBE_WAIT_MS = K8S_PROBE_SWEEP_CEILING_MS
export const K8S_PROBE_POLL_MS = 5_000
/**
 * How long a published answer may be adopted before a member probes again.
 *
 * The image reference is the key, and a reference is not always immutable: a template pinned to a
 * moving tag (`runtime-sandbox:latest`) keeps one key across rebuilds, and adopting there would
 * serve the PREVIOUS build's runtime versions and mcpBridge spec — the exact "module to retry
 * forever" failure the bridge comment warns about. The answer also depends on the deployment's
 * credentials, so a newly configured provider pair would otherwise never take effect. Nothing
 * re-probes on a timer: this only decides whether a member STARTING now inherits the answer, so a
 * short window costs at most one probe pod per hour per pool and self-heals both.
 */
export const K8S_PROBE_FRESH_MS = 60 * 60_000

// Every field of RuntimeProbeResult, deliberately: a field added to the interface and not here is
// dropped for ADOPTERS only, which reads as "the pool disagrees with itself" rather than as a bug.
const ProbeResultSchema = z.object({
  runtime: z.string().min(1),
  ok: z.boolean(),
  models: z.array(z.string()),
  currentModel: z.string().optional(),
  acpProtocolVersion: z.number().int().optional(),
  probedVersion: z.string().optional(),
  mcpCapabilities: z.object({ http: z.boolean(), sse: z.boolean() }).optional(),
  configOptions: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  authRequired: z.boolean().optional(),
  uncredentialed: z.boolean().optional()
})

const K8sProbePayloadSchema = z.object({ table: K8sRuntimeTableSchema, results: z.array(ProbeResultSchema) })

/** Parse a published payload, or `undefined` for anything this daemon cannot read — a member
 *  running an older or newer shape must probe for itself rather than advertise a guess. */
export function parseK8sProbePayload(raw: string): K8sProbePayload | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = K8sProbePayloadSchema.safeParse(parsed)
  if (!result.success) return undefined
  // The ACP config options are carried verbatim: their shape is the runtime's, validated where it
  // is consumed, and re-describing it here would be a second definition to keep in step.
  return { table: result.data.table, results: result.data.results as unknown as RuntimeProbeResult[] }
}
