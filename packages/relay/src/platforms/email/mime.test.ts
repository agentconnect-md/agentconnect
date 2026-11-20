import { describe, expect, it } from 'vitest'
import { emailHeaderValues, evaluateEmailAuthentication, normalizeEmailMessage } from '@agentconnect.md/message'
import { emailHtmlToText, readEmailMime } from './mime.js'
import { AGENT_ADDRESS, AUTHSERV_ID, MEMBER, rawMail } from '../../../test/fixtures/email-messages.js'

const lines = (...parts: string[]) => Buffer.from(parts.join('\r\n'), 'utf8')

describe('email MIME reader', () => {
  it('keeps every header in the order the message carried it, so a forged Authentication-Results stays below the provider one', async () => {
    const mail = await readEmailMime(
      rawMail({ headers: ['Authentication-Results: forged.example.test; dmarc=pass header.from=corp.example.test'] })
    )
    expect(mail.headers.slice(0, 3).map((header) => header.name)).toEqual([
      'authentication-results',
      'received',
      'authentication-results'
    ])
    const [topmost, second] = emailHeaderValues(mail.headers, 'Authentication-Results')
    expect(topmost).toContain(`${AUTHSERV_ID};`)
    expect(second).toContain('forged.example.test;')
    expect(evaluateEmailAuthentication({ headers: mail.headers, authservId: AUTHSERV_ID, from: MEMBER })).toEqual({
      ok: true,
      via: 'dmarc'
    })
    // With the forged one on top, as a message the provider added nothing to would carry it, the check refuses.
    const forged = await readEmailMime(
      rawMail({
        authentication: null,
        headers: ['Authentication-Results: forged.example.test; dmarc=pass header.from=corp.example.test']
      })
    )
    expect(evaluateEmailAuthentication({ headers: forged.headers, authservId: AUTHSERV_ID, from: MEMBER })).toEqual({
      ok: false,
      reason: 'authserv'
    })
  })

  it('unfolds a folded header and decodes an encoded subject and display name', async () => {
    const mail = await readEmailMime(
      lines(
        'From: =?UTF-8?B?w4VzYQ==?= <asa@corp.example.test>',
        `To: ${AGENT_ADDRESS}`,
        'Subject: =?UTF-8?Q?Hello_w=C3=B6rld?=',
        'References: <a@corp.example.test>',
        ' <b@corp.example.test>',
        'Message-ID: <c@corp.example.test>',
        '',
        'Body'
      )
    )
    expect(emailHeaderValues(mail.headers, 'subject')).toEqual(['Hello wörld'])
    expect(emailHeaderValues(mail.headers, 'references')[0]).toMatch(
      /<a@corp\.example\.test>\s+<b@corp\.example\.test>/
    )
    expect(mail.from).toEqual([{ address: 'asa@corp.example.test', name: 'Åsa' }])
    expect(mail.text?.trim()).toBe('Body')
  })

  it('hands over every To and Cc entry, one it cannot make an address of included', async () => {
    const mail = await readEmailMime(
      rawMail({
        to: `${AGENT_ADDRESS}, "Bob Example" <bob@corp.example.test>, Team: carol@corp.example.test, dave@corp.example.test;`,
        cc: 'Someone Without An Address, erin@corp.example.test'
      })
    )
    expect(mail.to).toEqual([
      { address: AGENT_ADDRESS },
      { address: 'bob@corp.example.test', name: 'Bob Example' },
      { address: 'carol@corp.example.test' },
      { address: 'dave@corp.example.test' }
    ])
    expect(mail.cc).toEqual([{ name: 'Someone Without An Address' }, { address: 'erin@corp.example.test' }])
    const normalized = normalizeEmailMessage(mail, { agentAddress: AGENT_ADDRESS, traceId: 't' })
    expect(normalized.kind === 'message' && normalized.message.adapterExt?.email).toMatchObject({
      unreadableRecipients: 1,
      cc: [{ address: 'erin@corp.example.test' }]
    })
  })

  it('reads two addresses in From, and two From fields, as more than one sender', async () => {
    const two = await readEmailMime(rawMail({ from: `${MEMBER}, eve@other.example.test` }))
    expect(two.from).toHaveLength(2)
    const twice = await readEmailMime(rawMail({ headers: ['From: eve@other.example.test'] }))
    expect(twice.from).toHaveLength(2)
    for (const mail of [two, twice])
      expect(normalizeEmailMessage(mail, { agentAddress: AGENT_ADDRESS, traceId: 't' })).toEqual({
        kind: 'invalid',
        reason: 'sender'
      })
  })

  it('prefers the text part, decodes its transfer encoding, and names attachments without their bytes', async () => {
    const mail = await readEmailMime(
      rawMail({
        contentType: 'multipart/mixed; boundary="outer"',
        body: [
          '--outer',
          'Content-Type: multipart/alternative; boundary="inner"',
          '',
          '--inner',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: quoted-printable',
          '',
          'Caf=C3=A9 numbers',
          '--inner',
          'Content-Type: text/html; charset=utf-8',
          '',
          '<p>Caf&eacute; <b>numbers</b></p>',
          '--inner--',
          '--outer',
          'Content-Type: application/pdf; name="report.pdf"',
          'Content-Disposition: attachment; filename="report.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.alloc(300, 1).toString('base64'),
          '--outer--',
          ''
        ].join('\r\n')
      })
    )
    expect(mail.text?.trim()).toBe('Café numbers')
    expect(mail.attachments).toEqual([{ name: 'report.pdf', type: 'application/pdf', size: 300 }])
    expect(JSON.stringify(mail)).not.toContain(Buffer.alloc(300, 1).toString('base64').slice(0, 40))
  })

  it('turns an HTML-only body into text', async () => {
    const mail = await readEmailMime(
      rawMail({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><title>T</title><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>there</b>,</p><p>see <a href="https://example.test/x?a=1&amp;b=2">the report</a>.</p><script>alert(1)</script></body></html>'
      })
    )
    expect(mail.text).toBe('Hello there,\n\nsee the report (https://example.test/x?a=1&b=2).')
  })

  it('parses a message cut mid-attachment as far as it goes and flags it', async () => {
    const whole = rawMail({
      contentType: 'multipart/mixed; boundary="outer"',
      body: [
        '--outer',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'The numbers are attached.',
        '--outer',
        'Content-Type: application/octet-stream; name="big.bin"',
        'Content-Disposition: attachment; filename="big.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.alloc(6_000, 2).toString('base64'),
        '--outer--',
        ''
      ].join('\r\n')
    })
    const cut = await readEmailMime(whole.subarray(0, whole.length - 3_000), true)
    expect(cut.truncated).toBe(true)
    expect(cut.text?.trim()).toBe('The numbers are attached.')
    expect(cut.attachments).toHaveLength(1)
    expect(cut.attachments![0]).toMatchObject({ name: 'big.bin', type: 'application/octet-stream' })
    const normalized = normalizeEmailMessage(cut, { agentAddress: AGENT_ADDRESS, traceId: 't' })
    expect(normalized.kind === 'message' && normalized.message.adapterExt?.email).toMatchObject({ truncated: true })
    // The same bytes read whole are not flagged.
    expect((await readEmailMime(whole)).truncated).toBeUndefined()
  })
})

describe('emailHtmlToText', () => {
  it('breaks lines at blocks and list items, and keeps a link target once', () => {
    expect(
      emailHtmlToText(
        '<div>One</div><div>Two<br>Three</div><ul><li>a</li><li>b</li></ul><table><tr><td>x</td><td>y</td></tr></table>'
      )
    ).toBe('One\nTwo\nThree\n- a\n- b\n\nx y')
    expect(emailHtmlToText('<a href="https://example.test/">https://example.test/</a>')).toBe('https://example.test/')
    expect(emailHtmlToText('<a href="mailto:bob@corp.example.test">bob@corp.example.test</a>')).toBe(
      'bob@corp.example.test'
    )
    expect(emailHtmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click')
  })

  it('reads text that only looks like markup as text, and drops comments and unfinished markup', () => {
    expect(emailHtmlToText('1 < 2 and 3 > 2 &amp; &#x41;&#66; &unknown;')).toBe('1 < 2 and 3 > 2 & AB &unknown;')
    expect(emailHtmlToText('before<!-- hidden -->after<!-- never closed')).toBe('beforeafter')
    expect(emailHtmlToText('kept<script>never closed')).toBe('kept')
    expect(emailHtmlToText('kept <b unfinished')).toBe('kept')
  })

  it('stays fast on input built to make a careless scan quadratic', () => {
    const started = performance.now()
    for (const hostile of [
      '<'.repeat(400_000),
      '<a '.repeat(150_000),
      '<!--'.repeat(100_000),
      '<script>'.repeat(60_000),
      '<b> </b>'.repeat(60_000),
      '<a href="https://example.test/">x</a>'.repeat(20_000),
      '<br>'.repeat(120_000)
    ])
      emailHtmlToText(hostile)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
