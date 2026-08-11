import { describe, it, expect } from 'vitest'
import { toSlackAttachment } from '../src/slack-message.js'
import { toTelegramPhotoAttachment } from '../src/telegram-message.js'
import { toDiscordAttachment } from '../src/discord-message.js'

describe('toSlackAttachment thumbnailUrl', () => {
  it('prefers the smallest available thumb_* rendition', () => {
    const att = toSlackAttachment({
      id: 'F1',
      name: 'shot.png',
      mimetype: 'image/png',
      url_private: 'https://files.slack.com/f1',
      thumb_720: 'https://files.slack.com/t720',
      thumb_1024: 'https://files.slack.com/t1024'
    })
    expect(att?.thumbnailUrl).toBe('https://files.slack.com/t720')
  })

  it('omits thumbnailUrl when Slack reports no thumb_* rendition', () => {
    const att = toSlackAttachment({
      id: 'F1',
      name: 'doc.pdf',
      mimetype: 'application/pdf',
      url_private: 'https://files.slack.com/f1'
    })
    expect(att?.thumbnailUrl).toBeUndefined()
  })
})

describe('toTelegramPhotoAttachment thumbnailUrl', () => {
  it('uses the smallest PhotoSize file_id as the thumbnail, the largest as the source', () => {
    const att = toTelegramPhotoAttachment([
      { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
      { file_id: 'medium', file_unique_id: 'u1', width: 320, height: 320 },
      { file_id: 'large', file_unique_id: 'u1', width: 1280, height: 1280 }
    ])
    expect(att?.sourceUrl).toBe('large')
    expect(att?.thumbnailUrl).toBe('small')
  })

  it('omits thumbnailUrl for a single-size photo', () => {
    const att = toTelegramPhotoAttachment([{ file_id: 'only', width: 100, height: 100 }])
    expect(att?.sourceUrl).toBe('only')
    expect(att?.thumbnailUrl).toBeUndefined()
  })
})

describe('toDiscordAttachment thumbnailUrl', () => {
  it('derives a width-limited proxy URL for an image attachment', () => {
    const att = toDiscordAttachment({
      id: 'a1',
      name: 'shot.png',
      contentType: 'image/png',
      url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
      proxyUrl: 'https://media.discordapp.net/attachments/1/2/shot.png'
    })
    expect(att?.thumbnailUrl).toBe('https://media.discordapp.net/attachments/1/2/shot.png?width=320')
  })

  it('omits thumbnailUrl for a non-image attachment', () => {
    const att = toDiscordAttachment({
      id: 'a1',
      name: 'doc.pdf',
      contentType: 'application/pdf',
      url: 'https://cdn.discordapp.com/attachments/1/2/doc.pdf',
      proxyUrl: 'https://media.discordapp.net/attachments/1/2/doc.pdf'
    })
    expect(att?.thumbnailUrl).toBeUndefined()
  })

  it('preserves a signed proxy URL’s ex/is/hm query params when adding width', () => {
    const att = toDiscordAttachment({
      id: 'a1',
      name: 'shot.png',
      contentType: 'image/png',
      url: 'https://cdn.discordapp.com/attachments/1/2/shot.png?ex=66b1&is=66af&hm=deadbeef&',
      proxyUrl: 'https://media.discordapp.net/attachments/1/2/shot.png?ex=66b1&is=66af&hm=deadbeef&'
    })
    const url = new URL(att!.thumbnailUrl!)
    expect(url.searchParams.get('width')).toBe('320')
    expect(url.searchParams.get('ex')).toBe('66b1')
    expect(url.searchParams.get('is')).toBe('66af')
    expect(url.searchParams.get('hm')).toBe('deadbeef')
  })
})
