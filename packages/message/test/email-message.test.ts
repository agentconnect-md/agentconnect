import { describe, expect, it } from 'vitest'
import {
  NormalizedPlatformMessageSchema,
  WireEmailAdapterExt,
  manifestFor,
  type NormalizedPlatformMessage
} from '@agentconnect.md/protocol'
import {
  EMAIL_BODY_MAX_BYTES,
  EMAIL_CUT_MARKER,
  canonicalEmailAddress,
  cutEmailBody,
  emailAgentAddress,
  emailAttachmentNotes,
  emailAutomaticReason,
  emailConversation,
  emailFallbackThreadKey,
  emailParticipants,
  emailThreadCandidates,
  evaluateEmailAuthentication,
  isReservedEmailName,
  normalizeEmailMessage,
  parseEmailMessageIds,
  renderEmailHeaderBlock,
  validateEmailName,
  type EmailHeader,
  type EmailInboundMessage
} from '../src/email-message.js'
import { nativeMessageId } from '../src/wire-coordinates.js'
import {
  AGENT,
  ALICE,
  AUTHSERV,
  BOB,
  CAROL,
  DKIM_PASS,
  DMARC_PASS,
  MAIL_DOMAIN,
  SPF_PASS,
  authResults,
  dmNew,
  dmReply,
  groupNew,
  header,
  mail
} from './fixtures/email-messages.js'

const CONTEXT = { agentAddress: AGENT, traceId: 'trace-1', receivedAtMs: 1_793_612_400_000 }

function messageOf(payload: EmailInboundMessage): NormalizedPlatformMessage {
  const result = normalizeEmailMessage(payload, CONTEXT)
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.reason}`)
  // Every normalized message is a valid wire payload whose extension is the declared one.
  expect(NormalizedPlatformMessageSchema.parse(result.message)).toEqual(result.message)
  expect(WireEmailAdapterExt.parse(result.message.adapterExt?.email)).toEqual(result.message.adapterExt?.email)
  return result.message
}

const extOf = (message: NormalizedPlatformMessage) => WireEmailAdapterExt.parse(message.adapterExt?.email)

describe('email address names (§3)', () => {
  it('stores a name lower-cased', () => {
    expect(validateEmailName('Release-Notes.2')).toEqual({ ok: true, name: 'release-notes.2' })
    expect(validateEmailName('abc')).toEqual({ ok: true, name: 'abc' })
    expect(validateEmailName('a'.repeat(40))).toEqual({ ok: true, name: 'a'.repeat(40) })
  })

  it('refuses a name outside 3 to 40 characters', () => {
    expect(validateEmailName('ab')).toEqual({ ok: false, reason: 'length' })
    expect(validateEmailName('a'.repeat(41))).toEqual({ ok: false, reason: 'length' })
  })

  it('refuses other characters, an edge that is not a letter or digit, and two dots in a row', () => {
    for (const name of ['.helper', 'helper-', 'help_er', 'help+er', 'help er', 'help..er', 'hélper', 'a@b'])
      expect(validateEmailName(name), name).toEqual({ ok: false, reason: 'characters' })
  })

  it('refuses role names, however they are punctuated or cased', () => {
    for (const name of ['postmaster', 'abuse', 'admin', 'security', 'support', 'billing', 'noreply', 'No-Reply'])
      expect(validateEmailName(name), name).toEqual({ ok: false, reason: 'reserved' })
    expect(isReservedEmailName('post.master')).toBe(true)
    expect(isReservedEmailName('mailer-daemon')).toBe(true)
    expect(isReservedEmailName('support-bot')).toBe(false)
  })
})

describe('email address canonicalization (§3)', () => {
  it('lower-cases an address and keeps another person’s tag', () => {
    expect(canonicalEmailAddress(' Alice+Lists@Corp.Example.TEST ')).toBe('alice+lists@corp.example.test')
  })

  it('refuses what is not a bare address', () => {
    for (const address of [
      'Alice <alice@corp.example.test>',
      '"a b"@corp.example.test',
      'alice@localhost',
      'alice',
      ''
    ])
      expect(canonicalEmailAddress(address), address).toBeUndefined()
  })

  it('ignores a tag only on the agent’s own domain', () => {
    expect(emailAgentAddress('Helper+Billing@Mail.Example.Test', MAIL_DOMAIN)).toBe(AGENT)
    expect(emailAgentAddress(AGENT, MAIL_DOMAIN)).toBe(AGENT)
    expect(emailAgentAddress('alice+lists@corp.example.test', MAIL_DOMAIN)).toBeUndefined()
    expect(emailAgentAddress(`+tag@${MAIL_DOMAIN}`, MAIL_DOMAIN)).toBeUndefined()
  })
})

describe('automatic mail (§4 step 1)', () => {
  const reason = (headers: readonly EmailHeader[], over: { envelopeFrom?: string; from?: string } = {}) =>
    emailAutomaticReason({
      headers,
      envelopeFrom: 'bounce@corp.example.test',
      from: ALICE,
      mailDomain: MAIL_DOMAIN,
      ...over
    })

  it('lets a person’s message through', () => {
    expect(reason(dmNew.headers)).toBeUndefined()
    expect(reason([header('Auto-Submitted', 'no'), header('Precedence', 'first-class')])).toBeUndefined()
  })

  it('reads every marker of an automatic message', () => {
    expect(reason([header('auto-submitted', 'auto-replied; owner=someone')])).toBe('auto_submitted')
    expect(reason([header('Auto-Submitted', 'auto-generated')])).toBe('auto_submitted')
    for (const precedence of ['bulk', 'List', ' junk '])
      expect(reason([header('Precedence', precedence)]), precedence).toBe('precedence')
    expect(reason([header('List-Id', '<updates.example.test>')])).toBe('list')
    expect(reason([header('List-Unsubscribe', '<https://lists.example.test/leave>')])).toBe('list')
  })

  it('discards a bounce and mail from the deployment’s own domain', () => {
    expect(reason([], { envelopeFrom: '' })).toBe('null_sender')
    expect(reason([], { envelopeFrom: '<>' })).toBe('null_sender')
    expect(reason([], { from: `other@${MAIL_DOMAIN}` })).toBe('own_domain')
    expect(reason([], { envelopeFrom: `<bounce@${MAIL_DOMAIN.toUpperCase()}>` })).toBe('own_domain')
  })
})

describe('Authentication-Results (§4 step 2)', () => {
  const verdict = (headers: EmailHeader[], from = ALICE) =>
    evaluateEmailAuthentication({ headers, authservId: AUTHSERV, from })

  it('accepts a DMARC pass from the provider', () => {
    expect(verdict([authResults(DMARC_PASS)])).toEqual({ ok: true, via: 'dmarc' })
    // A version, a quoted value and a trailing separator are all RFC 8601.
    expect(
      verdict([header('Authentication-Results', `${AUTHSERV} 1; dmarc=pass header.from="corp.example.test";`)])
    ).toEqual({ ok: true, via: 'dmarc' })
  })

  it('refuses a DMARC result that is not a pass, even beside an aligned signature', () => {
    for (const result of ['fail', 'temperror', 'permerror', 'bestguesspass'])
      expect(verdict([authResults(`${DKIM_PASS}; dmarc=${result} header.from=corp.example.test`)]), result).toEqual({
        ok: false,
        reason: 'dmarc'
      })
  })

  it('refuses a pass about another From domain, or two DMARC results', () => {
    expect(verdict([authResults('dmarc=pass header.from=other.example.test')])).toEqual({ ok: false, reason: 'dmarc' })
    expect(verdict([authResults('dmarc=fail; dmarc=pass header.from=corp.example.test')])).toEqual({
      ok: false,
      reason: 'dmarc'
    })
  })

  it('accepts an aligned DKIM pass only where there is no DMARC record', () => {
    expect(verdict([authResults(`${DKIM_PASS}; dmarc=none; ${SPF_PASS}`)])).toEqual({ ok: true, via: 'dkim' })
    expect(verdict([authResults(DKIM_PASS)])).toEqual({ ok: true, via: 'dkim' })
    // A parent of the From domain may sign for it.
    expect(verdict([authResults(`${DKIM_PASS}; dmarc=none`)], 'alice@eu.corp.example.test')).toEqual({
      ok: true,
      via: 'dkim'
    })
  })

  it('refuses a DKIM pass that does not cover the From domain', () => {
    const refused = { ok: false, reason: 'dkim' }
    expect(verdict([authResults('dkim=pass header.d=other.example.test; dmarc=none')])).toEqual(refused)
    expect(verdict([authResults('dkim=pass header.d=eu.corp.example.test; dmarc=none')])).toEqual(refused)
    expect(
      verdict([authResults('dkim=pass header.d=notcorp.example.test; dmarc=none')], 'a@corp.example.test')
    ).toEqual(refused)
    expect(verdict([authResults('dkim=pass header.d=test; dmarc=none')])).toEqual(refused)
    expect(verdict([authResults('dkim=fail header.d=corp.example.test; dmarc=none')])).toEqual(refused)
    expect(verdict([authResults('dkim=pass header.i=@corp.example.test; dmarc=none')])).toEqual(refused)
    expect(verdict([authResults(`${SPF_PASS}; dmarc=none`)])).toEqual(refused)
    expect(verdict([header('Authentication-Results', `${AUTHSERV}; none`)])).toEqual(refused)
  })

  it('reads only the topmost header, so a forged one below the provider’s is never seen', () => {
    const forged = authResults(DMARC_PASS)
    expect(verdict([authResults('dmarc=fail header.from=corp.example.test'), forged])).toEqual({
      ok: false,
      reason: 'dmarc'
    })
    expect(verdict([authResults('dkim=none; dmarc=none'), forged])).toEqual({ ok: false, reason: 'dkim' })
  })

  it('refuses a topmost header another server signed, whatever the provider’s says below it', () => {
    const foreign = authResults(DMARC_PASS, 'mx.attacker.example.test')
    expect(verdict([foreign, authResults(DMARC_PASS)])).toEqual({ ok: false, reason: 'authserv' })
    expect(verdict([authResults(DMARC_PASS, `${AUTHSERV}.attacker.example.test`)])).toEqual({
      ok: false,
      reason: 'authserv'
    })
    expect(verdict([authResults(DMARC_PASS, AUTHSERV.toUpperCase())])).toEqual({ ok: true, via: 'dmarc' })
  })

  it('refuses a message with no header, or one it cannot read', () => {
    expect(verdict([header('From', ALICE)])).toEqual({ ok: false, reason: 'missing' })
    const unparsable = [
      '',
      `${AUTHSERV} 2; dmarc=pass`,
      `${AUTHSERV} extra words; dmarc=pass`,
      `${AUTHSERV}; dmarc=pass (never closed`,
      `${AUTHSERV}; dmarc=pass header.from="corp.example.test`,
      `${AUTHSERV}; dmarc pass`,
      `${AUTHSERV}; dmarc=pass header.from`,
      `${AUTHSERV}; dmarc=pass header.from=a.example.test header.from=corp.example.test`,
      `${AUTHSERV}; ; dmarc=pass`,
      `${AUTHSERV}; dmarc=pass) header.from=corp.example.test`
    ]
    for (const value of unparsable)
      expect(verdict([header('Authentication-Results', value)]), value).toEqual({ ok: false, reason: 'unparsable' })
    expect(verdict([authResults(DMARC_PASS)], 'Alice <alice@corp.example.test>')).toEqual({
      ok: false,
      reason: 'sender'
    })
  })

  it('does not take a pass written inside a comment or a quoted string', () => {
    expect(verdict([authResults('dmarc=fail (dmarc=pass) header.from=corp.example.test')])).toEqual({
      ok: false,
      reason: 'dmarc'
    })
    expect(verdict([authResults('dmarc=fail reason="x; dmarc=pass"')])).toEqual({ ok: false, reason: 'dmarc' })
  })
})

describe('mail threads (§5.1)', () => {
  it('reads message IDs in order, each once and without brackets', () => {
    expect(parseEmailMessageIds('<a@x.example.test>\r\n <b@x.example.test> junk <a@x.example.test>')).toEqual([
      'a@x.example.test',
      'b@x.example.test'
    ])
    expect(parseEmailMessageIds(`<${'a'.repeat(513)}> <ok@x.example.test>`)).toEqual(['ok@x.example.test'])
    expect(parseEmailMessageIds('no brackets')).toEqual([])
    expect(parseEmailMessageIds(undefined)).toEqual([])
  })

  it('lists the candidates nearest first: References newest to oldest, then In-Reply-To', () => {
    expect(emailThreadCandidates({ references: ['root', 'mid', 'last'], inReplyTo: 'other' })).toEqual([
      'last',
      'mid',
      'root',
      'other'
    ])
    expect(emailThreadCandidates({ references: ['root', 'last'], inReplyTo: 'last' })).toEqual(['last', 'root'])
    expect(emailThreadCandidates({ references: [] })).toEqual([])
  })

  it('falls back on the first References ID, then In-Reply-To, then the message’s own ID', () => {
    expect(emailFallbackThreadKey({ messageId: 'own', references: ['root', 'last'], inReplyTo: 'last' })).toBe('root')
    expect(emailFallbackThreadKey({ messageId: 'own', references: [], inReplyTo: 'parent' })).toBe('parent')
    expect(emailFallbackThreadKey({ messageId: 'own', references: [] })).toBe('own')
  })
})

describe('mail conversations (§5.2)', () => {
  const box = (address: string) => ({ address })

  it('leaves the agent’s own address out, tagged or not, and counts each other address once', () => {
    const tagged = `helper+billing@${MAIL_DOMAIN}`
    expect(emailParticipants({ from: box(ALICE), to: [box(AGENT), box(tagged)], cc: [] }, AGENT)).toEqual([ALICE])
    expect(
      emailParticipants({ from: box(ALICE), to: [box(AGENT), box(BOB), box(ALICE)], cc: [box(BOB), box(CAROL)] }, AGENT)
    ).toEqual([ALICE, BOB, CAROL])
  })

  it('keeps another person’s tag, and another agent’s address, as participants of their own', () => {
    const other = `planner@${MAIL_DOMAIN}`
    expect(
      emailParticipants({ from: box(ALICE), to: [box('alice+lists@corp.example.test'), box(other)], cc: [] }, AGENT)
    ).toEqual([ALICE, 'alice+lists@corp.example.test', other])
  })

  it('puts the sender alone in a direct conversation and anyone else in a group keyed by the thread', () => {
    expect(emailConversation([ALICE], 'm1@corp.example.test')).toEqual({ kind: 'dm', channel: `dm:${ALICE}` })
    expect(emailConversation([ALICE, BOB], 'm1@corp.example.test')).toEqual({
      kind: 'group',
      channel: 'group:m1@corp.example.test'
    })
  })
})

describe('what the agent reads (§5.4)', () => {
  it('renders the header block one field a line', () => {
    expect(renderEmailHeaderBlock(extOf(messageOf(groupNew)))).toBe(
      [
        `From: Alice Example <${ALICE}>`,
        `To: ${AGENT}`,
        `Cc: Bob Example <${BOB}>`,
        'Subject: Launch plan',
        'Date: Mon, 02 Nov 2026 09:30:00 +0000'
      ].join('\n')
    )
  })

  it('keeps a header value on its own line and a display name from posing as an address', () => {
    const block = renderEmailHeaderBlock({
      from: { address: ALICE, name: `Boss <${BOB}>\nTo: everyone` },
      to: [],
      cc: [],
      subject: 'Hello\r\nFrom: someone else'
    })
    expect(block).toBe(`From: Boss ${BOB} To: everyone <${ALICE}>\nSubject: Hello From: someone else`)
  })

  it('leaves a body within the limit as written', () => {
    const body = 'a'.repeat(EMAIL_BODY_MAX_BYTES)
    expect(cutEmailBody(body)).toEqual({ text: body, truncated: false })
    expect(cutEmailBody('')).toEqual({ text: '', truncated: false })
  })

  it('cuts a longer body on a character boundary and marks it', () => {
    // Each of these is three UTF-8 bytes, and 64 KiB is not a multiple of three.
    const cut = cutEmailBody('好'.repeat(30_000))
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe(`${'好'.repeat(Math.floor(EMAIL_BODY_MAX_BYTES / 3))}\n\n${EMAIL_CUT_MARKER}`)
    const astral = cutEmailBody(`${'a'.repeat(EMAIL_BODY_MAX_BYTES - 1)}😀tail`)
    expect(astral.text).toBe(`${'a'.repeat(EMAIL_BODY_MAX_BYTES - 1)}\n\n${EMAIL_CUT_MARKER}`)
  })

  it('marks a message that was cut before it was parsed', () => {
    expect(cutEmailBody('first part', true)).toEqual({ text: `first part\n\n${EMAIL_CUT_MARKER}`, truncated: true })
    expect(cutEmailBody('', true)).toEqual({ text: EMAIL_CUT_MARKER, truncated: true })
  })

  it('names each attachment as not delivered, with its type and size', () => {
    expect(
      emailAttachmentNotes([
        { name: 'report.pdf', type: 'application/pdf', size: 1_258_291 },
        { name: 'notes.txt', type: 'text/plain', size: 2048 },
        { name: 'empty.bin', type: 'application/octet-stream', size: 0 }
      ])
    ).toBe(
      [
        '[Attachment not delivered: report.pdf (application/pdf, 1.2 MB)]',
        '[Attachment not delivered: notes.txt (text/plain, 2.0 KB)]',
        '[Attachment not delivered: empty.bin (application/octet-stream, 0 bytes)]'
      ].join('\n')
    )
  })
})

describe('email normalization', () => {
  it('keys a member’s own message by the member and starts a thread at the message', () => {
    expect(messageOf(dmNew)).toEqual({
      msgId: `email:${AGENT}:m1@corp.example.test`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'email',
      channel: `dm:${ALICE}`,
      thread: 'm1@corp.example.test',
      sender: { id: ALICE, isBot: false, name: 'Alice Example' },
      text: 'Please summarize the attached numbers.',
      mentionedBots: [],
      isDm: true,
      platformTimeMs: 1_793_612_400_000,
      adapterExt: {
        email: {
          from: { address: ALICE, name: 'Alice Example' },
          to: [{ address: AGENT }],
          cc: [],
          subject: 'Quarterly report',
          date: 'Mon, 02 Nov 2026 09:30:00 +0000',
          messageId: 'm1@corp.example.test',
          references: [],
          attachments: []
        }
      }
    })
  })

  it('agrees with the manifest on which key is a direct conversation', () => {
    const pattern = manifestFor('email').dmChannelPattern
    expect(pattern?.test(messageOf(dmNew).channel)).toBe(true)
    expect(pattern?.test(messageOf(groupNew).channel)).toBe(false)
  })

  it('keys a reply by the first References ID and carries the chain for the daemon’s walk', () => {
    const message = messageOf(dmReply)
    expect(message.thread).toBe('m1@corp.example.test')
    expect(message.channel).toBe(`dm:${ALICE}`)
    expect(nativeMessageId(message.msgId)).toBe('m2@corp.example.test')
    const ext = extOf(message)
    expect(ext.inReplyTo).toBe('a1@mail.example.test')
    expect(emailThreadCandidates(ext)).toEqual(['a1@mail.example.test', 'm1@corp.example.test'])
  })

  it('makes a thread with a second person a group that addresses the agent', () => {
    const message = messageOf(groupNew)
    expect(message.channel).toBe('group:g1@corp.example.test')
    expect(message.thread).toBe('g1@corp.example.test')
    expect(message.isDm).toBe(false)
    expect(message.isGroupDm).toBe(true)
    expect(message.mentionedBots).toEqual([AGENT])
    expect(emailParticipants(extOf(message), AGENT)).toEqual([ALICE, BOB])
  })

  it('reads the agent’s own tagged address as the agent, so the sender is still alone', () => {
    const message = messageOf(mail({ to: [{ address: `Helper+Reports@${MAIL_DOMAIN}` }] }))
    expect(message.channel).toBe(`dm:${ALICE}`)
    expect(extOf(message).to).toEqual([{ address: `helper+reports@${MAIL_DOMAIN}` }])
  })

  it('refuses a message with no single sender', () => {
    const two = [{ address: ALICE }, { address: BOB }]
    expect(normalizeEmailMessage(mail({ from: two }), CONTEXT)).toEqual({ kind: 'invalid', reason: 'sender' })
    expect(normalizeEmailMessage(mail({ from: [{ address: 'not an address' }] }), CONTEXT)).toEqual({
      kind: 'invalid',
      reason: 'sender'
    })
    // A second From field is refused even when the reader reported only one address.
    const doubled = { ...dmNew, headers: [...dmNew.headers, header('From', BOB)] }
    expect(normalizeEmailMessage(doubled, CONTEXT)).toEqual({ kind: 'invalid', reason: 'sender' })
  })

  it('refuses a message with no single Message-ID', () => {
    const without = { ...dmNew, headers: dmNew.headers.filter((entry) => entry.name !== 'Message-ID') }
    const doubled = { ...dmNew, headers: [...dmNew.headers, header('Message-ID', '<other@corp.example.test>')] }
    const invalid = { kind: 'invalid', reason: 'message_id' }
    expect(normalizeEmailMessage(without, CONTEXT)).toEqual(invalid)
    expect(normalizeEmailMessage(doubled, CONTEXT)).toEqual(invalid)
    expect(normalizeEmailMessage(mail({ messageId: 'no-brackets@corp.example.test' }), CONTEXT)).toEqual(invalid)
    expect(normalizeEmailMessage(mail({ messageId: '<a@corp.example.test> <b@corp.example.test>' }), CONTEXT)).toEqual(
      invalid
    )
  })

  it('refuses more recipients than a reply can carry', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ address: `person-${index}@corp.example.test` }))
    expect(normalizeEmailMessage(mail({ to: [{ address: AGENT }], cc: many }), CONTEXT)).toEqual({
      kind: 'invalid',
      reason: 'recipients'
    })
    expect(extOf(messageOf(mail({ to: [{ address: AGENT }], cc: many.slice(1) }))).cc).toHaveLength(49)
  })

  it('drops a recipient it cannot read and one named twice', () => {
    const ext = extOf(
      messageOf(
        mail({
          to: [{ address: AGENT }, { address: 'undisclosed-recipients:;' }, {}],
          cc: [{ address: AGENT }, { address: BOB }]
        })
      )
    )
    expect(ext.to).toEqual([{ address: AGENT }])
    expect(ext.cc).toEqual([{ address: BOB }])
  })

  it('keeps the root and the newest IDs of an over-long References chain', () => {
    const chain = Array.from({ length: 60 }, (_, index) => `<r${index}@corp.example.test>`).join(' ')
    const { references } = extOf(messageOf(mail({ messageId: '<m9@corp.example.test>', references: chain })))
    expect(references).toHaveLength(50)
    expect(references[0]).toBe('r0@corp.example.test')
    expect(references[1]).toBe('r11@corp.example.test')
    expect(references.at(-1)).toBe('r59@corp.example.test')
  })

  it('keeps a message ID with a colon out of the msgId grammar’s separator', () => {
    const message = messageOf(mail({ messageId: '<a:b%c@corp.example.test>' }))
    expect(nativeMessageId(message.msgId)).toBe('a%3Ab%25c@corp.example.test')
    expect(extOf(message).messageId).toBe('a:b%c@corp.example.test')
    expect(message.thread).toBe('a:b%c@corp.example.test')
  })

  it('names attachments in the text and the extension, and never as files to fetch', () => {
    const message = messageOf(
      mail({
        text: 'See attached.',
        attachments: [
          { name: '../plan (final).pdf', type: 'Application/PDF', size: 2048 },
          { type: 'not a type', size: -1 }
        ]
      })
    )
    expect(message.attachments).toBeUndefined()
    expect(extOf(message).attachments).toEqual([
      { name: '.._plan _final_.pdf', type: 'application/pdf', size: 2048 },
      { name: 'attachment-2', type: 'application/octet-stream', size: 0 }
    ])
    expect(message.text).toBe(
      [
        'See attached.',
        '',
        '[Attachment not delivered: .._plan _final_.pdf (application/pdf, 2.0 KB)]',
        '[Attachment not delivered: attachment-2 (application/octet-stream, 0 bytes)]'
      ].join('\n')
    )
  })

  it('marks a cut message in the text and the extension', () => {
    const message = messageOf(mail({ text: 'first part', truncated: true }))
    expect(message.text).toBe(`first part\n\n${EMAIL_CUT_MARKER}`)
    expect(extOf(message).truncated).toBe(true)
    expect(extOf(messageOf(mail({ text: 'b'.repeat(EMAIL_BODY_MAX_BYTES + 1) }))).truncated).toBe(true)
    expect(extOf(messageOf(dmNew)).truncated).toBeUndefined()
  })

  it('keeps a subject on one line and delivers a message with no body', () => {
    const message = messageOf(mail({ subject: 'Line one\r\n\tline two', text: '' }))
    expect(extOf(message).subject).toBe('Line one line two')
    expect(message.text).toBe('')
  })
})
