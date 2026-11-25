import { describe, expect, it } from 'vitest'
import { formatArtifactMarker, parseArtifactMarker as protocolParseArtifactMarker } from '@agentconnect.md/protocol'
import {
  artifactKind,
  artifactPath,
  artifactZipName,
  markdownImageRefs,
  parseArtifactMarker,
  resolveArtifactRef
} from './artifact'

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'

describe('parseArtifactMarker', () => {
  it('reads the marker exactly as the protocol does', () => {
    const marker = formatArtifactMarker({ artifactId: ID, revision: 3, title: 'Q3 "report" [draft]\nfinal' })
    const texts = [
      `Here it is.\n${marker}`,
      marker,
      `${marker}\nmore`,
      `[artifact: ${ID} r0 "x"]`,
      `[artifact: ${ID.toUpperCase()} r1 "x"]`,
      `[artifact: ${ID} r1 "unterminated]`,
      `[artifact: ${ID} r1 "bad \\q escape"]`,
      `caption [artifact: ${ID} r1 "inline"]`,
      'no marker at all'
    ]
    for (const text of texts) expect(parseArtifactMarker(text), text).toEqual(protocolParseArtifactMarker(text))
    expect(parseArtifactMarker(`Here it is.\n${marker}`)).toEqual({
      caption: 'Here it is.',
      artifact: { artifactId: ID, revision: 3, title: 'Q3 "report" [draft]\nfinal' }
    })
  })
})

describe('artifactKind', () => {
  it('picks how an entry opens from its media type, with Markdown also known by its extension', () => {
    expect(artifactKind('text/html', 'index.html')).toBe('page')
    expect(artifactKind('text/markdown', 'README')).toBe('document')
    expect(artifactKind('text/plain', 'notes.md')).toBe('document')
    expect(artifactKind('image/svg+xml', 'chart.svg')).toBe('image')
    expect(artifactKind('application/pdf', 'report.pdf')).toBe('pdf')
    expect(artifactKind('application/json', 'data.json')).toBe('code')
    expect(artifactKind('text/csv; charset=utf-8', 'data.csv')).toBe('code')
    expect(artifactKind('application/vnd.api+json', 'x')).toBe('code')
    expect(artifactKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe(
      'other'
    )
  })
})

describe('resolveArtifactRef', () => {
  it('resolves a local reference beside the entry', () => {
    expect(resolveArtifactRef('README.md', 'img/chart.png')).toBe('img/chart.png')
    expect(resolveArtifactRef('docs/report.md', './chart.png?x=1#top')).toBe('docs/chart.png')
    expect(resolveArtifactRef('docs/report.md', '../assets/a%20b.png')).toBe('assets/a b.png')
  })

  it('refuses absolute, external and escaping references', () => {
    expect(resolveArtifactRef('README.md', '/etc/passwd')).toBeNull()
    expect(resolveArtifactRef('README.md', 'https://example.test/a.png')).toBeNull()
    expect(resolveArtifactRef('README.md', 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveArtifactRef('README.md', '../outside.png')).toBeNull()
    expect(resolveArtifactRef('README.md', '%E0%A4%A')).toBeNull()
  })
})

describe('markdownImageRefs', () => {
  it('collects inline image sources and reference definitions', () => {
    const md = [
      '![chart](img/chart.png "Chart")',
      '![spaced](<img/a b.png>)',
      '![ref][logo]',
      '[logo]: ./logo.svg',
      '[a link](notes.txt)'
    ].join('\n')
    expect(markdownImageRefs(md)).toEqual(['img/chart.png', 'img/a b.png', './logo.svg'])
  })
})

describe('artifact names and links', () => {
  it('names a zip after the title with unsafe characters replaced', () => {
    expect(artifactZipName('Q3 report: draft/final')).toBe('Q3 report- draft-final.zip')
    expect(artifactZipName('  ')).toBe('artifact.zip')
    expect(artifactZipName('..hidden')).toBe('hidden.zip')
  })

  it('pins a console link to its revision', () => {
    expect(artifactPath(ID, 2)).toBe(`/artifacts/${ID}?revision=2`)
    expect(artifactPath(ID)).toBe(`/artifacts/${ID}`)
  })
})
