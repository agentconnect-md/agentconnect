// Opaque page ids (computer-use.md §5.8): the daemon's own, mapped to DevTools targets and to the current child's page numbers.
import { randomBytes } from 'node:crypto'

/** A page target the browser lists (`/json/list`); its id never leaves the daemon. */
export interface DevtoolsTarget {
  id: string
  type: string
  url: string
  title: string
}

/** A page as one child lists it: its own small number, which changes with every child. */
export interface ListedPage {
  number: number
  url: string
  title: string
}

interface PageEntry {
  id: string
  // Undefined after its browser restarted, until a restored tab at the same address takes the id back.
  target?: string
  url: string
  title: string
}

// Ids kept from an earlier browser for restored tabs to take back, oldest dropped first.
const ORPHANS_MAX = 50

/** The pinned child's structured list: titles and URLs are data, even when they contain punctuation or line breaks. */
export function listedPages(value: unknown): ListedPage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const { id, url, title } = item as Record<string, unknown>
    return typeof id === 'number' && Number.isSafeInteger(id) && typeof url === 'string' && typeof title === 'string'
      ? [{ number: id, url, title }]
      : []
  })
}

/** The pages of one desktop's browser, by opaque id; one map lives as long as the desktop. */
export class PageIds {
  private entries: PageEntry[] = []
  private browser: string | undefined
  private child: object | undefined
  private readonly numbers = new Map<number, string>()
  private targetIds: string[] = []

  constructor(private readonly newId: () => string = () => `p${randomBytes(5).toString('hex')}`) {}

  /** Binds pages only when their address and title, or their address alone, identify one target. */
  sync(child: object, browser: string, listed: ListedPage[], targets: DevtoolsTarget[]): void {
    if (browser !== this.browser) {
      for (const entry of this.entries) delete entry.target
      this.browser = browser
      this.targetIds = []
    }
    if (child !== this.child) {
      this.numbers.clear()
      this.child = child
    }
    const pages = targets.filter((target) => target.type === 'page')
    if (listed.length > 0 && pages.length === 0) return
    this.targetIds = targets.map((target) => target.id)
    const live = new Set(pages.map((target) => target.id))
    // A tab closed in this browser drops its id; one from an earlier browser waits for its tab to be restored.
    this.entries = this.entries.filter((entry) => entry.target === undefined || live.has(entry.target))
    const orphans = this.entries.filter((entry) => entry.target === undefined)
    if (orphans.length > ORPHANS_MAX) {
      const dropped = new Set(orphans.slice(0, orphans.length - ORPHANS_MAX))
      this.entries = this.entries.filter((entry) => !dropped.has(entry))
    }
    const listedNumbers = new Set(listed.map((page) => page.number))
    for (const [number, id] of this.numbers) {
      if (!listedNumbers.has(number) || this.entry(id)?.target === undefined) this.numbers.delete(number)
    }
    const bound = new Set([...this.numbers.values()].map((id) => this.entry(id)?.target))
    const free = pages.filter((target) => !bound.has(target.id))
    const unmapped = listed.filter((page) => !this.numbers.has(page.number))
    for (const matchTitle of [true, false]) {
      const matches = (target: DevtoolsTarget, page: ListedPage) =>
        target.url === page.url && (!matchTitle || target.title === page.title)
      for (const page of [...unmapped]) {
        const candidates = free.filter((target) => matches(target, page))
        const target = candidates.length === 1 ? candidates[0]! : undefined
        if (!target || unmapped.filter((other) => matches(target, other)).length !== 1) continue
        free.splice(free.indexOf(target), 1)
        unmapped.splice(unmapped.indexOf(page), 1)
        this.numbers.set(page.number, this.bind(target, pages, listed).id)
      }
    }
    for (const entry of this.entries) {
      const target = pages.find((candidate) => candidate.id === entry.target)
      if (target) Object.assign(entry, { url: target.url, title: target.title })
    }
  }

  /** The opaque id of a child's page number, once synced. */
  idFor(child: object, number: number): string | undefined {
    return child === this.child ? this.numbers.get(number) : undefined
  }

  /** The current child's page number for an opaque id; undefined until a sync binds it in this child. */
  numberFor(child: object, id: string): number | undefined {
    if (child !== this.child) return undefined
    for (const [number, bound] of this.numbers) if (bound === id) return number
    return undefined
  }

  /** Whether the id names a page this desktop issued and still tracks. */
  known(id: string): boolean {
    return this.entry(id) !== undefined
  }

  targetFor(child: object, id: string): string | undefined {
    return this.numberFor(child, id) === undefined ? undefined : this.entry(id)?.target
  }

  /** The DevTools ids results must never carry: every target bound now, and the browser's own. */
  secrets(): string[] {
    const browser = this.browser?.split('/').pop()
    return browser ? [...this.targetIds, browser] : this.targetIds
  }

  private entry(id: string): PageEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  // The entry for a target: its own, else an earlier browser's at the same address (same title first), else a new one.
  private bind(target: DevtoolsTarget, targets: DevtoolsTarget[], listed: ListedPage[]): PageEntry {
    const own = this.entries.find((entry) => entry.target === target.id)
    if (own) return own
    const orphans = this.entries.filter((entry) => entry.target === undefined && entry.url === target.url)
    const sameTitle = orphans.filter((entry) => entry.title === target.title)
    const sameAddress = targets.filter((page) => page.url === target.url)
    const uniqueTitle = sameAddress.filter((page) => page.title === target.title).length === 1
    const uniqueAddress = sameAddress.length === 1 && listed.filter((page) => page.url === target.url).length === 1
    const orphan =
      uniqueTitle && sameTitle.length === 1
        ? sameTitle[0]
        : uniqueAddress && orphans.length === 1
          ? orphans[0]
          : undefined
    if (orphan) {
      Object.assign(orphan, { target: target.id, url: target.url, title: target.title })
      return orphan
    }
    const entry: PageEntry = { id: this.newId(), target: target.id, url: target.url, title: target.title }
    this.entries.push(entry)
    return entry
  }
}

/** The public list includes only pages this child can address unambiguously. */
export function pageListText(pages: ListedPage[], idFor: (number: number) => string | undefined): string {
  const lines = pages.flatMap(({ number, url, title }) => {
    const id = idFor(number)
    const address = url.replace(/[\r\n]/g, ' ')
    return id ? [`${id}: ${title ? `${title.replace(/[\r\n]/g, ' ')} (${address})` : address}`] : []
  })
  if (lines.length < pages.length) lines.push('Some tabs could not be identified. Use the desktop to inspect them.')
  return ['## Pages', ...lines].join('\n')
}

/** Text with every DevTools target id, the browser id, `/devtools/…` paths and `ws://` URLs removed. */
export function withoutDevtoolsIds(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]')
  }
  return out
    .replace(/\bws:\/\/[^\s"'<>`]+/gi, '[redacted]')
    .replace(/\bwss:\/\/[^\s"'<>`]*\/devtools\/[^\s"'<>`]*/gi, '[redacted]')
    .replace(
      /\/devtools\/(page|browser|worker|shared_worker|service_worker|iframe|other)\/[0-9a-f-]{8,}/gi,
      '/devtools/[redacted]'
    )
}
