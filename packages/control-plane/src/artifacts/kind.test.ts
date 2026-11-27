import { describe, expect, it } from 'vitest'
import { artifactKind } from './kind.js'

describe('artifactKind', () => {
  it.each([
    ['text/html', 'index.html', 'page'],
    ['application/xhtml+xml', 'index.xhtml', 'page'],
    ['text/html; charset=utf-8', 'index.html', 'page'],
    ['text/markdown', 'README', 'document'],
    ['text/plain', 'notes.md', 'document'],
    ['application/octet-stream', 'NOTES.MARKDOWN', 'document'],
    ['image/png', 'chart.png', 'image'],
    ['image/svg+xml', 'logo.svg', 'image'],
    ['application/pdf', 'report.pdf', 'pdf'],
    ['text/plain', 'log.txt', 'code'],
    ['text/csv', 'data.csv', 'code'],
    ['application/json', 'data.json', 'code'],
    ['application/vnd.api+json', 'data.json', 'code'],
    ['application/atom+xml', 'feed.xml', 'code'],
    ['APPLICATION/X-YAML', 'config.yaml', 'code'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx', 'other'],
    ['application/zip', 'bundle.zip', 'other'],
    ['', 'blob', 'other']
  ])('%s at %s opens as %s', (mediaType, path, kind) => {
    expect(artifactKind(mediaType, path)).toBe(kind)
  })
})
