// The operations a GraphQL document defines, read without a GraphQL parser: enough to pick the one a request executes (github-app-git-credentials.md, Phase 2).

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription'

/** One top-level operation: its type and, unless anonymous, its name. */
export interface GraphqlOperation {
  type: GraphqlOperationType
  name?: string
}

type Definition = { type: GraphqlOperationType | 'fragment'; name?: string }

const KEYWORDS: ReadonlySet<string> = new Set(['query', 'mutation', 'subscription', 'fragment'])

/** Each top-level operation in order, or undefined when the document cannot be read safely. */
export function graphqlOperations(document: string): GraphqlOperation[] | undefined {
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
      i = commentEnd(document, i)
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
        definitions.push({ type: 'query' })
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
      const j = nameEnd(document, i)
      const word = document.slice(i, j)
      if (braces === 0 && parens === 0 && !open && KEYWORDS.has(word)) {
        const named = nameAfter(document, j)
        definitions.push({ type: word as Definition['type'], ...(named ? { name: named.name } : {}) })
        open = true
        i = named ? named.end : j
        continue
      }
      i = j
      continue
    }
    i += 1
  }
  if (braces !== 0 || parens !== 0 || open) return undefined
  return definitions.filter((definition): definition is GraphqlOperation => definition.type !== 'fragment')
}

/** The operation a request executes: the one `operationName` names, else the document's only one; a reason when there is none. */
export function executedOperation(document: string, operationName: unknown): GraphqlOperation | { refused: string } {
  const operations = graphqlOperations(document)
  if (!operations || operations.length === 0) return { refused: 'the GraphQL document could not be read' }
  if (operationName !== undefined && operationName !== null) {
    if (typeof operationName !== 'string') return { refused: 'the GraphQL operationName is not a string' }
    const named = operations.filter((operation) => operation.name === operationName)
    if (named.length !== 1)
      return { refused: `the GraphQL document defines no single operation named ${operationName}` }
    return named[0]!
  }
  if (operations.length !== 1) return { refused: 'the GraphQL document defines several operations and names none' }
  return operations[0]!
}

/** The index just past a comment. */
function commentEnd(document: string, start: number): number {
  let i = start
  while (i < document.length && document[i] !== '\n' && document[i] !== '\r') i += 1
  return i
}

/** The index just past a name starting at `start`. */
function nameEnd(document: string, start: number): number {
  let j = start + 1
  while (j < document.length && /\w/.test(document[j]!)) j += 1
  return j
}

/** The name that follows a keyword, past ignored tokens, when one does. */
function nameAfter(document: string, start: number): { name: string; end: number } | undefined {
  let i = start
  while (i < document.length) {
    const c = document[i]!
    if (c === '#') i = commentEnd(document, i)
    else if (/[\s,﻿]/.test(c)) i += 1
    else break
  }
  if (i >= document.length || !/[A-Za-z_]/.test(document[i]!)) return undefined
  const end = nameEnd(document, i)
  return { name: document.slice(i, end), end }
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
