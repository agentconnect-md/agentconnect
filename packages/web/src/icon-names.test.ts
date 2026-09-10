import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lucideIcon } from '@/components/ui'

const WEB_SRC = fileURLToPath(new URL('.', import.meta.url))
const COMPONENTS = join(WEB_SRC, 'components')

/** Every console source a name can be shipped from. Tests are excluded: their fixtures name icons that never render. */
function consoleSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return consoleSources(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return [path]
  })
}

/** Only what the value can EVALUATE to — a comparison operand, an index, and a call argument all test a name here
 *  rather than being one, as `{t === 'dark' ? 'sun' : 'moon'}` and `{p.includes('/') ? 'file' : 'file-text'}` do. */
function iconNameLiterals(value: string): string[] {
  const evaluated = value
    .replace(/[=!]==?\s*(?:'[^']*'|"[^"]*")/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.\w+\([^()]*\)/g, '')
  return [...evaluated.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2]!)
}

/** `<Icon name=…>`, both the plain literal and each branch of a `name={cond ? 'a' : 'b'}`. */
function directIconNames(code: string): string[] {
  return [...code.matchAll(/<Icon\s[^>]*?\/>/g)].flatMap((tag) => {
    const attribute = /\bname=(\{[^{}]*\}|'[^']*'|"[^"]*")/.exec(tag[0])
    return attribute ? iconNameLiterals(attribute[1]!) : []
  })
}

/** The `icon` prop, field or local a menu item, confirm dialog or nav tile hands to `<Icon name>` one hop later. */
function forwardedIconNames(code: string): string[] {
  return [...code.matchAll(/\bicon\s*[:=]\s*(\{[^{}]*\}|'[^']*'|"[^"]*"|[^\n,;]*)/g)].flatMap((match) =>
    iconNameLiterals(match[1]!)
  )
}

function namesIn(source: string, forwarded: boolean): string[] {
  // Comments go first, so prose quoting a name does not read as one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  return [...directIconNames(code), ...(forwarded ? forwardedIconNames(code) : [])]
}

describe('every icon name the console renders exists in lucide', () => {
  // Outside `components/` an `icon` field is something else — a registry URL, an agent's avatar union — so it is scoped.
  const used = consoleSources(WEB_SRC).flatMap((file) =>
    namesIn(readFileSync(file, 'utf8'), file.startsWith(COMPONENTS)).map((name) => ({ file, name }))
  )

  it('reads the names a source ships and skips the ones it only mentions', () => {
    const read = (source: string) => namesIn(source, true)
    expect(read(`<Icon name="trash" size={14} />`)).toEqual(['trash'])
    expect(read(`<Icon name={busy ? 'loader' : 'refresh-cw'} size={14} />`)).toEqual(['loader', 'refresh-cw'])
    expect(read(`<Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />`)).toEqual(['sun', 'moon'])
    expect(read(`<Icon name={p.includes('/') ? 'file' : 'file-text'} size={13} />`)).toEqual(['file', 'file-text'])
    expect(read(`{ icon: (tile(f)?.icon ?? 'plus') as Parameters<typeof Icon>[0]['name'] }`)).toEqual(['plus'])
    expect(read(`<Icon name={a ? 'plus' : b ? 'minus' : 'x'} size={14} />`)).toEqual(['plus', 'minus', 'x'])
    expect(read(`<Icon\n  name="plus"\n  size={13}\n/>`)).toEqual(['plus'])
    expect(read(`{ icon: 'settings-2' as const, label: 'Settings' }`)).toEqual(['settings-2'])
    expect(read(`<Confirm verb="Remove" icon={remove ? 'trash' : 'unplug'} />`)).toEqual(['trash', 'unplug'])
    expect(read(`<Confirm icon="trash" verb="Remove" />`)).toEqual(['trash'])
    expect(read(`const icon = isUpgrade ? 'circle-arrow-up' : 'refresh-cw'`)).toEqual(['circle-arrow-up', 'refresh-cw'])
    expect(read(`<AgentIconView icon={agent?.icon} size={22} />`)).toEqual([])
    expect(read(`// an <Icon name="not-an-icon" /> in prose`)).toEqual([])
    expect(read(`/* an <Icon name="not-an-icon" /> in a block */`)).toEqual([])
  })

  // Each sweep is asserted on its own: a broken matcher would find nothing and pass the check below vacuously.
  it('still finds the console files that name icons', () => {
    const forwarded = consoleSources(COMPONENTS).flatMap((file) => forwardedIconNames(readFileSync(file, 'utf8')))
    expect(used.length).toBeGreaterThan(100)
    expect(used.some(({ name }) => name === 'trash')).toBe(true)
    expect(forwarded.length).toBeGreaterThan(0)
  })

  // A dropped name renders NOTHING — no error, just an empty box, the way `trash-2` emptied every delete control.
  it('resolves every one to a component', () => {
    const missing = used.filter(({ name }) => !lucideIcon(name))
    expect(missing.map(({ file, name }) => `${relative(WEB_SRC, file)}: '${name}'`)).toEqual([])
  })
})
