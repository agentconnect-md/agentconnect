import { describe, expect, it } from 'vitest'
import { onlyCandidatesFor } from './rtc.js'

describe('onlyCandidatesFor', () => {
  it('keeps only the advertised host candidate', () => {
    const sdp = [
      'v=0',
      'a=candidate:1 1 udp 2130706431 172.17.0.2 7700 typ host',
      'a=candidate:2 1 udp 2130706431 192.168.64.7 7701 typ host',
      'a=end-of-candidates',
      ''
    ].join('\r\n')
    expect(onlyCandidatesFor(sdp, '192.168.64.7')).toBe(
      ['v=0', 'a=candidate:2 1 udp 2130706431 192.168.64.7 7701 typ host', 'a=end-of-candidates', ''].join('\r\n')
    )
  })
})
