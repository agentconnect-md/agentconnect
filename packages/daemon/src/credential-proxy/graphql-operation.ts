// The operation types a GraphQL document defines, read without a GraphQL parser: enough to keep GraphQL read-only (github-app-git-credentials.md, Phase 2).

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription'

type Definition = GraphqlOperationType | 'fragment'

const KEYWORDS: ReadonlySet<string> = new Set(['query', 'mutation', 'subscription', 'fragment'])

/** Each top-level operation's type in order, or undefined when the document cannot be read safely. */
export function graphqlOperationTypes(document: string): GraphqlOperationType[] | undefined {
  const definitions: Definition[] = []
  // A keyword opens a definition that stays open until its selection set closes, so its name is never read as another one.
  let open = false
  let braces = 0
  let parens = 0
  let i = 0
  const n = document.length
  while (i < n) {
    const c = document[i]!
    if (c === '#') {
      while (i < n && document[i] !== '\n' && document[i] !== '\r') i += 1
      continue
    }
    if (c === '"') {
      const end = stringEnd(document, i)
      if (end === undefined) return undefined
      i = end
      continue
    }
    if (c === '{') {
      if (braces === 0 && parens === 0 && !open) {
        definitions.push('query')
        open = true
      }
      braces += 1
    } else if (c === '}') {
      braces -= 1
      if (braces < 0) return undefined
      if (braces === 0 && parens === 0) open = false
    } else if (c === '(') {
      parens += 1
    } else if (c === ')') {
      parens -= 1
      if (parens < 0) return undefined
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /\w/.test(document[j]!)) j += 1
      const word = document.slice(i, j)
      if (braces === 0 && parens === 0 && !open && KEYWORDS.has(word)) {
        definitions.push(word as Definition)
        open = true
      }
      i = j
      continue
    }
    i += 1
  }
  if (braces !== 0 || parens !== 0 || open) return undefined
  return definitions.filter((definition): definition is GraphqlOperationType => definition !== 'fragment')
}

/** The index just past a string starting at `start`, block or single-line, or undefined when it never closes. */
function stringEnd(document: string, start: number): number | undefined {
  if (document.startsWith('"""', start)) {
    let i = start + 3
    while (i < document.length) {
      if (document.startsWith('\\"""', i)) i += 4
      else if (document.startsWith('"""', i)) return i + 3
      else i += 1
    }
    return undefined
  }
  let i = start + 1
  while (i < document.length) {
    const c = document[i]
    if (c === '\n' || c === '\r') return undefined
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i += 1
  }
  return undefined
}
