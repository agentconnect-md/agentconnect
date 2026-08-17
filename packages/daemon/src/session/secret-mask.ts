/**
 * Defense-in-depth masking of write-only secret VALUES (agent
 * `runtimeOverrides.secrets`) from everything an agent emits.
 *
 * The daemon merges secret values into the ACP child's process environment
 * (agents/agent-env.ts) so the agent's commands and code can legitimately USE
 * them — which also means the agent can trivially read them back (`env`,
 * `printenv`, `process.env`). The conversational surfaces, however, must never
 * carry the plaintext value: platform messages, the live webchat stream,
 * persisted transcripts (including tool rawInput/rawOutput — the console's
 * "View detail"), GitHub comments, memory extraction, and the interactive
 * permission/elicitation cards. Masking every string of every inbound
 * SessionUpdate at the daemon ingress (Daemon.onAcpUpdate — the single entry
 * point all of those consumers hang off) covers them in one place.
 *
 * This is containment for accidental echoes (an `env | grep KEY` pasted into
 * chat), not a security boundary: an agent told to exfiltrate a value can
 * re-encode it beyond recognition. The behavioral half — telling the agent
 * which env vars are secrets and not to reveal them — is the standing-context
 * notice in session/session-manager.ts.
 *
 * Config-file secrets (shim/config-file-env.ts) put STRUCTURED values in
 * play — a whole kubeconfig YAML or docker config.json — which the agent may
 * echo re-formatted (`cat`, pretty-print, a single grepped line) so a literal
 * whole-value match would miss. Each secret therefore expands into masking
 * VARIANTS (expandSecretVariants): the raw value, normalized JSON renderings
 * when it parses as JSON/YAML, string leaves under credential-ish keys
 * (`token`, `client-key-data`, `auths`…), and credential-shaped runs (base64 /
 * PEM lines, JWT segments) that survive re-flowing and chunk splits.
 */
import { parse as parseYaml } from 'yaml'

export interface SecretMaskEntry {
  name: string
  value: string
}

/** Secrets shorter than this are unmaskable: replacing every 1–3-char hit would
 *  mangle unrelated output ("1", "abc", …) while protecting nothing real. Same
 *  posture as GitHub Actions' guidance that very short secrets can't be masked. */
export const MIN_MASKABLE_SECRET_LENGTH = 4

/** What a masked value renders as. Naming the KEY (never the value) keeps the
 *  redaction debuggable — the reader can tell WHICH secret flowed where. */
export function secretPlaceholder(name: string): string {
  return `[secret:${name}]`
}

/** Keys whose subtree values are credential material when a secret parses as
 *  JSON/YAML — kubeconfig `token`/`client-key-data`/`password`, docker `auths`. */
const SENSITIVE_KEY = /token|password|secret|auth|key|cert|credential/i

/** Structured leaves shorter than this are skipped: masking a `"none"` or an
 *  8601 date fragment everywhere would mangle output while protecting little. */
const MIN_SENSITIVE_LEAF_LENGTH = 8

/** Credential-shaped runs: base64 blobs / PEM lines / JWT segments. 24+ chars
 *  of the class, so prose and common identifiers ("kubernetes-admin") never
 *  match, while any real key/cert line does — even re-flowed or chunk-split. */
const CREDENTIAL_RUN = /[A-Za-z0-9+/_.=-]{24,}/g

/** A run shaped like a DNS name — dot-separated alnum/dash labels ending in an
 *  alphabetic TLD, no base64 markers (`+/=_`). Long cluster/registry endpoints
 *  (an EKS server FQDN) match CREDENTIAL_RUN but are addresses, not credential
 *  material — masking them would redact ordinary kubectl/docker output. Real
 *  key/cert/JWT runs virtually always carry a base64 marker or a digit-bearing
 *  final segment, so they never fit this shape. */
function looksLikeHostname(run: string): boolean {
  const labels = run.split('.')
  if (labels.length < 3) return false
  if (!/^[A-Za-z]{2,24}$/.test(labels[labels.length - 1]!)) return false
  return labels.every((label) => /^[A-Za-z0-9-]+$/.test(label))
}

/** Per-secret needle cap (a many-cert kubeconfig expands wide): keep the longest. */
const MAX_VARIANTS_PER_SECRET = 64

/** JSON first (exact), then YAML (superset, kubeconfig). Non-object results are
 *  useless for expansion. The `[:{[]` gate keeps plain tokens away from parsers. */
function parseStructured(value: string): unknown {
  if (!/[:{[]/.test(value)) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    /* not JSON */
  }
  try {
    const parsed: unknown = parseYaml(value)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    /* not YAML either */
  }
  return undefined
}

/** Collect string leaves that sit anywhere under a SENSITIVE_KEY. `visited`
 *  guards YAML anchor aliases (shared/cyclic references) from re-walks. */
function collectSensitiveLeaves(node: unknown, sensitive: boolean, out: Set<string>, visited: Set<object>): void {
  if (typeof node === 'string') {
    if (sensitive && node.length >= MIN_SENSITIVE_LEAF_LENGTH) out.add(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (visited.has(node)) return
  visited.add(node)
  if (Array.isArray(node)) {
    for (const item of node) collectSensitiveLeaves(item, sensitive, out, visited)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    collectSensitiveLeaves(value, sensitive || SENSITIVE_KEY.test(key), out, visited)
  }
}

/**
 * Expand one secret value into the needle set to mask: the literal value, its
 * normalized JSON renderings (minified + 2-space — catches an agent that
 * pretty-prints the parsed object), sensitive-key leaves, and credential-shaped
 * runs. Longest-first, deduplicated, capped at MAX_VARIANTS_PER_SECRET.
 */
export function expandSecretVariants(value: string): string[] {
  const variants = new Set<string>([value])
  const parsed = parseStructured(value)
  if (parsed !== undefined) {
    try {
      variants.add(JSON.stringify(parsed))
      variants.add(JSON.stringify(parsed, null, 2))
    } catch {
      /* cyclic YAML aliases — leaves still collected below */
    }
    collectSensitiveLeaves(parsed, false, variants, new Set())
  }
  for (const match of value.matchAll(CREDENTIAL_RUN)) {
    if (!looksLikeHostname(match[0])) variants.add(match[0])
  }
  return [...variants]
    .filter((v) => v.length >= MIN_MASKABLE_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_VARIANTS_PER_SECRET)
}

/** Expansion runs YAML/JSON parses, and the caller sits on the per-update hot
 *  path — memoize per agent OBJECT (reconcile replaces the object on any edit). */
const expansionCache = new WeakMap<object, SecretMaskEntry[]>()

/**
 * The maskable {name,value} pairs of an agent: every variant of every secret
 * long enough to mask, longest value first so a secret that is a substring of
 * another can't split the longer match. Returns [] for an absent agent / no
 * secrets.
 */
export function maskableSecrets(agent?: {
  runtimeOverrides?: { secrets?: { name: string; value: string }[] }
}): SecretMaskEntry[] {
  if (!agent) return []
  const cached = expansionCache.get(agent)
  if (cached) return cached
  const entries: SecretMaskEntry[] = []
  const seen = new Set<string>()
  for (const { name, value } of agent.runtimeOverrides?.secrets ?? []) {
    for (const variant of expandSecretVariants(value)) {
      if (seen.has(variant)) continue
      seen.add(variant)
      entries.push({ name, value: variant })
    }
  }
  entries.sort((a, b) => b.value.length - a.value.length)
  expansionCache.set(agent, entries)
  return entries
}

/** Replace every literal occurrence of each secret value in `text`. */
export function maskSecretsInText(text: string, entries: SecretMaskEntry[]): string {
  let out = text
  for (const e of entries) {
    if (out.includes(e.value)) out = out.split(e.value).join(secretPlaceholder(e.name))
  }
  return out
}

/**
 * Copy-on-write deep mask over a JSON-ish value (the parsed ACP frame): every
 * string anywhere in the structure is masked; numbers/booleans/null are left
 * alone. Returns the SAME reference when nothing matched, so the hot no-secret
 * path allocates nothing.
 */
export function maskSecretsDeep<T>(node: T, entries: SecretMaskEntry[]): T {
  if (entries.length === 0 || node == null) return node
  if (typeof node === 'string') {
    return maskSecretsInText(node, entries) as T
  }
  if (Array.isArray(node)) {
    let out: unknown[] | null = null
    for (let i = 0; i < node.length; i++) {
      const masked = maskSecretsDeep(node[i], entries)
      if (masked !== node[i] && !out) out = node.slice()
      if (out) out[i] = masked
    }
    return (out ?? node) as T
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    let out: Record<string, unknown> | null = null
    for (const key of Object.keys(obj)) {
      const masked = maskSecretsDeep(obj[key], entries)
      if (masked !== obj[key] && !out) out = { ...obj }
      if (out) out[key] = masked
    }
    return (out ?? node) as T
  }
  return node
}
