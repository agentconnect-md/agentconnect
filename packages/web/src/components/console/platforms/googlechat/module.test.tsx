import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlatformMark } from '@/components/marks'
import { chatRoomSigil, platformLabel } from '@/lib/platform-labels'
import { botSharingEditable, channelListSemantics, platformRegistry, platformTextRenderer } from '../registry'
import { googleChatModule } from './index'
import GoogleChatMarkdownText from './text'

describe('the Google Chat module', () => {
  it('registers under its platform id with its mark, label and renderer', () => {
    expect(platformRegistry.get('googlechat')).toBe(googleChatModule)
    expect(platformLabel('googlechat')).toEqual({ name: 'Google Chat', picker: 'Google Chat', sigil: '' })
    expect(platformTextRenderer('googlechat')).toBe(googleChatModule.textRenderer)
  })

  it('offers no transport choice and no shared bot, and reuses a freed app on http', () => {
    expect(googleChatModule.wizard.affordances).toEqual({})
    expect(botSharingEditable({ platform: 'googlechat', transport: 'http', shareable: false })).toBe(false)
    expect(
      googleChatModule.wizard.buildReuseInput({ id: 'bot-1' } as never, { agentId: 'agent-a', shared: false })
    ).toEqual({ platform: 'googlechat', agentId: 'agent-a', botId: 'bot-1', transport: 'http' })
  })

  it('draws the multi-color mark, not the monochrome glyph', () => {
    const markup = renderToStaticMarkup(<PlatformMark platform="googlechat" />)
    for (const color of ['#00af57', '#0ebc5f', '#94d4ff']) expect(markup).toContain(color)
    expect(markup).not.toContain('currentColor')
  })
})

describe('Google Chat channel semantics', () => {
  const semantics = channelListSemantics('googlechat')

  it('calls a room a space and writes it without a sigil', () => {
    expect(semantics.roomNoun).toBe('space')
    expect(semantics.roomGlyph).toBe('')
    expect(chatRoomSigil('googlechat')).toBe('')
    expect(semantics.leave).toBe('none')
  })

  it('keeps mention triggers in a space and drops every-message, which Google never delivers', () => {
    expect(semantics.triggers).toContain('mention')
    expect(semantics.triggers).toContain('off')
    expect(semantics.triggers).not.toContain('any')
  })
})

describe('Google Chat transcript text', () => {
  const render = (text: string) => renderToStaticMarkup(<GoogleChatMarkdownText text={text} />)

  it('renders the formatting Google Chat renders', () => {
    const html = render('**bold** _italic_ ~~gone~~ `code` [docs](https://example.test/docs)\n\n- one\n- two')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<del>gone</del>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">docs</a>')
    expect(html).toContain('<ul>')
    expect(render('```\nconst x = 1\n```')).toContain('<pre><code>const x = 1')
    expect(render('> quoted')).toContain('<blockquote>')
  })

  it('shows what Google Chat does not render as its text', () => {
    const html = render('# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).not.toMatch(/<h1|<table/)
    expect(html).toContain('Title')
  })

  it('keeps single line breaks and drops non-web links', () => {
    expect(render('one\ntwo')).toContain('one<br/>')
    expect(render('[run](javascript:alert(1))')).not.toContain('<a')
  })
})
