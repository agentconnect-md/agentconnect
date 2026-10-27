// Source Cache bucket lifecycle rules (source-cache.md §10): the document operators apply, and a pure check of what a bucket has.

export type SourceCacheLifecycleTagValue = 'pending' | 'unreferenced'

/** Days after object creation each tag-filtered rule expires an object. */
export const SOURCE_CACHE_LIFECYCLE_DAYS: Readonly<Record<SourceCacheLifecycleTagValue, number>> = {
  pending: 2,
  unreferenced: 7
}

const TAG_KEY = 'ac-cache'
const TAG_VALUES: readonly SourceCacheLifecycleTagValue[] = ['pending', 'unreferenced']
const MAX_RULES = 1000

/** The `src/` prefix the rules scope to, under the configured prefix. */
export function sourceCacheSrcPrefix(prefix: string): string {
  return prefix ? `${prefix}/src/` : 'src/'
}

function snapshotsPrefix(prefix: string): string {
  return prefix ? `${prefix}/snapshots/` : 'snapshots/'
}

export interface SourceCacheLifecycleDocument {
  Rules: Array<{
    ID: string
    Status: 'Enabled'
    Filter: { And: { Prefix: string; Tags: Array<{ Key: string; Value: string }> } }
    Expiration: { Days: number }
  }>
}

/** The `put-bucket-lifecycle-configuration` JSON for these two rules; an operator merges it with the bucket's own. */
export function sourceCacheLifecycleRules(prefix: string): SourceCacheLifecycleDocument {
  return {
    Rules: TAG_VALUES.map((value) => ({
      ID: `ac-source-cache-${value}`,
      Status: 'Enabled' as const,
      Filter: { And: { Prefix: sourceCacheSrcPrefix(prefix), Tags: [{ Key: TAG_KEY, Value: value }] } },
      Expiration: { Days: SOURCE_CACHE_LIFECYCLE_DAYS[value] }
    }))
  }
}

/** Days after initiation the abort rule reaps an unfinished multipart upload's parts (source-cache-file-transfer.md §2). */
export const MULTIPART_ABORT_DAYS = 1

/** The rule that reaps abandoned multipart uploads under `src/`; S3 admits no tag filter on it, so it stands alone. */
export function multipartAbortLifecycleRule(prefix: string) {
  return {
    ID: 'ac-source-cache-multipart-abort',
    Status: 'Enabled' as const,
    Filter: { Prefix: sourceCacheSrcPrefix(prefix) },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: MULTIPART_ABORT_DAYS }
  }
}

export interface SourceCacheLifecycleEvaluation {
  pending: boolean
  unreferenced: boolean
  /** Whether an enabled rule aborts unfinished multipart uploads anywhere under `src/`. */
  multipartAbort: boolean
  /** The shortest expiration, in days, any enabled rule can give a `pending`-tagged object under `src/`; undefined when none does. */
  pendingShortestDays: number | undefined
  warnings: string[]
}

function decode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? match[1] : undefined
}

function elements(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]!)
}

interface ParsedRule {
  id: string
  enabled: boolean
  days: number | undefined
  abortDays: number | undefined
  prefix: string
  tags: Array<{ key: string; value: string }>
  sizeFiltered: boolean
}

function parseRule(xml: string): ParsedRule {
  const filter = element(xml, 'Filter')
  const outside = filter === undefined ? xml : xml.replace(/<Filter(?:\s[^>]*)?>[\s\S]*?<\/Filter>/, '')
  const scope = filter === undefined ? '' : (element(filter, 'And') ?? filter)
  const prefix = filter === undefined ? element(outside, 'Prefix') : element(scope, 'Prefix')
  const daysText = element(element(outside, 'Expiration') ?? '', 'Days')
  const days = daysText === undefined ? undefined : Number(decode(daysText))
  const abortText = element(element(outside, 'AbortIncompleteMultipartUpload') ?? '', 'DaysAfterInitiation')
  const abortDays = abortText === undefined ? undefined : Number(decode(abortText))
  return {
    id: decode(element(outside, 'ID') ?? '(unnamed)'),
    enabled: decode(element(outside, 'Status') ?? '') === 'Enabled',
    days: days !== undefined && Number.isSafeInteger(days) && days > 0 ? days : undefined,
    abortDays: abortDays !== undefined && Number.isSafeInteger(abortDays) && abortDays > 0 ? abortDays : undefined,
    prefix: decode(prefix ?? ''),
    tags: elements(scope, 'Tag').map((tag) => ({
      key: decode(element(tag, 'Key') ?? ''),
      value: decode(element(tag, 'Value') ?? '')
    })),
    sizeFiltered: filter !== undefined && /<ObjectSize(?:GreaterThan|LessThan)\b/.test(filter)
  }
}

/** Whether a bucket's GetBucketLifecycleConfiguration XML expires both tags under `<prefix>/src/`; foreign rules are ignored. */
export function evaluateSourceCacheLifecycle(xml: string, prefix: string): SourceCacheLifecycleEvaluation {
  const src = sourceCacheSrcPrefix(prefix)
  const snapshots = snapshotsPrefix(prefix)
  const result: SourceCacheLifecycleEvaluation = {
    pending: false,
    unreferenced: false,
    multipartAbort: false,
    pendingShortestDays: undefined,
    warnings: []
  }
  for (const block of elements(xml, 'Rule').slice(0, MAX_RULES)) {
    const rule = parseRule(block)
    if (!rule.enabled) continue
    // An abort rule counts only when it reaches every upload under src/: no tag or size filter, a prefix at or above it.
    if (rule.abortDays !== undefined && rule.tags.length === 0 && !rule.sizeFiltered && src.startsWith(rule.prefix))
      result.multipartAbort = true
    if (rule.days === undefined) continue
    const overlapsSrc = src.startsWith(rule.prefix) || rule.prefix.startsWith(src)
    const ours = rule.tags.length === 1 && rule.tags[0]!.key === TAG_KEY ? rule.tags[0]!.value : undefined
    // Any untagged or `pending` rule reaching src/, however narrow, can cut some pending object's window short.
    if (overlapsSrc && (rule.tags.length === 0 || ours === 'pending'))
      result.pendingShortestDays = Math.min(result.pendingShortestDays ?? rule.days, rule.days)
    if (ours === undefined) {
      // Only an untagged rule can reach live bundles: a foreign-tag filter never matches an ac-cache-only object.
      if (overlapsSrc && rule.tags.length === 0)
        result.warnings.push(
          `lifecycle rule ${rule.id} expires objects under ${src} with no ${TAG_KEY} filter, live bundles included`
        )
      continue
    }
    if (!TAG_VALUES.includes(ours as SourceCacheLifecycleTagValue)) continue
    const value = ours as SourceCacheLifecycleTagValue
    // A rule scoped below src/ misses some bundles, so it does not count.
    if (!src.startsWith(rule.prefix) || rule.sizeFiltered) continue
    result[value] = true
    if (snapshots.startsWith(rule.prefix))
      result.warnings.push(`lifecycle rule ${rule.id} also covers ${snapshots}; scope it to ${src}`)
    if (rule.days > SOURCE_CACHE_LIFECYCLE_DAYS[value])
      result.warnings.push(
        `lifecycle rule ${rule.id} expires ${TAG_KEY}=${value} after ${rule.days} days (design default ${SOURCE_CACHE_LIFECYCLE_DAYS[value]})`
      )
  }
  return result
}
