import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url))

// Parse syntax rather than matching comments, strings, or only one spelling of an import.
function moduleReferences(text: string): string[] {
  const source = ts.createSourceFile('boundary.ts', text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function dependencies(file: string): { specifier: string; path: string }[] {
  return moduleReferences(readFileSync(file, 'utf8')).map((specifier) => ({
    specifier,
    path: specifier.startsWith('.')
      ? relative(sourceRoot, resolve(dirname(file), specifier)).replaceAll('\\', '/')
      : specifier
  }))
}

describe('AHP application import boundaries', () => {
  it('keeps the host on shared application ports instead of legacy transport or direct ACP execution', () => {
    const violations: string[] = []
    const sources = files(join(sourceRoot, 'ahp'))
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      for (const dependency of dependencies(file)) {
        if (
          dependency.path.startsWith('webchat/') ||
          dependency.path.startsWith('acp/') ||
          dependency.path === '@agentclientprotocol/sdk' ||
          dependency.path.startsWith('@agentclientprotocol/sdk/')
        ) {
          violations.push(`${relative(sourceRoot, file)} -> ${dependency.specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the extracted chat application, continuation, attachments and output protocol-neutral', () => {
    const violations: string[] = []
    const modules = [
      'chat-application',
      'chat-continuation',
      'chat-attachments',
      'chat-output',
      'chat-transcript',
      'chat-turn',
      'chat-events',
      'chat-observer'
    ]
    for (const name of modules) {
      const file = join(sourceRoot, 'session', `${name}.ts`)
      for (const dependency of dependencies(file)) {
        if (
          dependency.path.startsWith('ahp/') ||
          dependency.path.startsWith('webchat/') ||
          dependency.path === '@microsoft/agent-host-protocol' ||
          dependency.path.startsWith('@microsoft/agent-host-protocol/')
        ) {
          violations.push(`${relative(sourceRoot, file)} -> ${dependency.specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('recognizes static, dynamic, type-only and re-export edges without treating comments as dependencies', () => {
    expect(
      moduleReferences(`
      // import { ignored } from 'comment-only'
      const text = "import('ordinary-string')";
      import type { Port } from 'type-import';
      export { Adapter } from 're-export';
      type Sink = import('type-expression').Sink;
      import Legacy = require('import-equals');
      const module = await import('dynamic-import');
      const other = require('commonjs');
    `)
    ).toEqual(['type-import', 're-export', 'type-expression', 'import-equals', 'dynamic-import', 'commonjs'])
  })
})
