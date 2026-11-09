import { describe, expect, it } from 'vitest'
import { fileExtension, messageCards } from './ComposerFiles'

describe('fileExtension', () => {
  it('reads the name, else the MIME subtype', () => {
    expect(fileExtension('Small.Town.S01.torrent')).toBe('torrent')
    expect(fileExtension('README', 'text/plain')).toBe('plain')
    expect(fileExtension('README')).toBe('file')
  })
})

describe('messageCards', () => {
  it('shows an uploaded image once, by its preview, and every other file by name', () => {
    const shot = { name: 'shot.png', mimeType: 'image/png' as const, data: 'QUJD' }
    const cards = messageCards(
      [shot],
      [
        { name: 'shot.png', mimeType: 'image/png' },
        { name: 'report.pdf', mimeType: 'application/pdf' }
      ]
    )
    expect(cards.map((c) => [c.name, !!c.image])).toEqual([
      ['shot.png', true],
      ['report.pdf', false]
    ])
  })
})
