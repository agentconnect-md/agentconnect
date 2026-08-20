// Compares the runtime table baked into the runtime-sandbox image against a fresh probe of that same image.
// The image pins what a runtime IS: its id, version, executable, and the ACP snapshot it answers initialize with.
// It does not pin a config option's `values` — that roster is fetched upstream at probe time and moves on its own.
// A cache-hit build ships a table as old as the cached layer, so byte equality failed on drift the image never caused.

/** Rendered for one failure line: the point is which field moved, not a dump of both tables. */
function render(value) {
  const text = JSON.stringify(value ?? null)
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** Set math over ids and option values, which are strings in every table this generator writes. */
const keyOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))

function only(present, absent) {
  const other = new Set(absent.map(keyOf))
  return [...new Set(present.map(keyOf))].filter((item) => !other.has(item)).sort()
}

const listOrNone = (items) => (items.length > 0 ? items.join(', ') : 'none')

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const omit = (value, key) =>
  isPlain(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) : value

/** Exact comparison of everything under `path`, so a field the generator adds later is pinned without being listed. */
function deepDiff(path, published, probed, failures) {
  if (isPlain(published) && isPlain(probed)) {
    for (const key of [...new Set([...Object.keys(published), ...Object.keys(probed)])].sort()) {
      deepDiff(`${path}.${key}`, published[key], probed[key], failures)
    }
    return
  }
  if (Array.isArray(published) && Array.isArray(probed) && published.length === probed.length) {
    published.forEach((item, index) => deepDiff(`${path}[${index}]`, item, probed[index], failures))
    return
  }
  if (JSON.stringify(published ?? null) !== JSON.stringify(probed ?? null)) {
    failures.push(`${path}: published ${render(published)}, probed ${render(probed)}`)
  }
}

/** Option ids, categories and types are the image's; the values inside one are upstream's and only warn. */
function diffConfigOptions(prefix, published, probed, failures, warnings) {
  const publishedOptions = Array.isArray(published) ? published : []
  const probedOptions = Array.isArray(probed) ? probed : []
  const dropped = only(
    publishedOptions.map((option) => option?.id),
    probedOptions.map((option) => option?.id)
  )
  const gained = only(
    probedOptions.map((option) => option?.id),
    publishedOptions.map((option) => option?.id)
  )
  if (dropped.length > 0 || gained.length > 0) {
    failures.push(
      `${prefix}.acp.configOptions: published only ${listOrNone(dropped)}, probed only ${listOrNone(gained)}`
    )
  }
  const probedById = new Map(probedOptions.map((option) => [keyOf(option?.id), option]))
  for (const option of publishedOptions) {
    const fresh = probedById.get(keyOf(option?.id))
    if (!fresh) continue
    const path = `${prefix}.acp.configOptions[${option.id}]`
    deepDiff(path, omit(option, 'values'), omit(fresh, 'values'), failures)
    if (!Array.isArray(option.values) || !Array.isArray(fresh.values)) {
      deepDiff(`${path}.values`, option.values, fresh.values, failures)
      continue
    }
    const removed = only(option.values, fresh.values)
    const added = only(fresh.values, option.values)
    if (removed.length > 0 || added.length > 0) {
      warnings.push(`${path}.values drifted upstream — added ${listOrNone(added)}, removed ${listOrNone(removed)}`)
    }
  }
}

/** Failures mean the table lies about what this image runs; warnings mean only an upstream roster moved. */
export function diffRuntimeTables(published, probed) {
  const failures = []
  const warnings = []
  const publishedRuntimes = published?.runtimes
  const probedRuntimes = probed?.runtimes
  if (!Array.isArray(publishedRuntimes) || !Array.isArray(probedRuntimes)) {
    failures.push(`runtimes: published ${render(publishedRuntimes)}, probed ${render(probedRuntimes)}`)
    return { failures, warnings }
  }
  deepDiff('table', omit(published, 'runtimes'), omit(probed, 'runtimes'), failures)
  const dropped = only(
    publishedRuntimes.map((entry) => entry?.id),
    probedRuntimes.map((entry) => entry?.id)
  )
  const gained = only(
    probedRuntimes.map((entry) => entry?.id),
    publishedRuntimes.map((entry) => entry?.id)
  )
  if (dropped.length > 0 || gained.length > 0) {
    failures.push(`runtime ids: published only ${listOrNone(dropped)}, probed only ${listOrNone(gained)}`)
  }
  const probedById = new Map(probedRuntimes.map((entry) => [keyOf(entry?.id), entry]))
  for (const entry of publishedRuntimes) {
    const fresh = probedById.get(keyOf(entry?.id))
    if (!fresh) continue
    deepDiff(
      entry.id,
      { ...entry, acp: omit(entry.acp, 'configOptions') },
      { ...fresh, acp: omit(fresh.acp, 'configOptions') },
      failures
    )
    diffConfigOptions(entry.id, entry.acp?.configOptions, fresh.acp?.configOptions, failures, warnings)
  }
  return { failures, warnings }
}
