import { describe, expect, it } from 'vitest'
import type { RTCPeerConnection } from 'werift'
import { iceReport, onlyCandidatesFor, withoutReflexive } from './rtc.js'

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

describe('iceReport', () => {
  it('lists both sides’ candidates and each pair’s state and checks', () => {
    const host = { type: 'host', host: '10.0.0.5', port: 40000 }
    const srflx = { type: 'srflx', host: '64.38.144.146', port: 40000 }
    const remote = { type: 'srflx', host: '198.51.100.7', port: 6000 }
    const pc = {
      iceTransports: [
        {
          connection: {
            state: 'checking',
            localCandidates: [host, srflx],
            remoteCandidates: [remote],
            checkList: [
              {
                localCandidate: host,
                remoteCandidate: remote,
                state: 4,
                requestsSent: 7,
                responsesReceived: 0,
                requestsReceived: 0
              }
            ]
          }
        }
      ]
    } as unknown as RTCPeerConnection
    expect(iceReport(pc, 2)).toBe(
      'ICE checking; local host 10.0.0.5:40000, srflx 64.38.144.146:40000; remote srflx 198.51.100.7:6000 (2 trickled); ' +
        'pairs sent/answered/received host → srflx 198.51.100.7:6000 failed 7/0/0'
    )
  })

  it('says so when the peer has no ICE transport', () => {
    expect(iceReport({ iceTransports: [] } as unknown as RTCPeerConnection, 0)).toBe('no ICE transport')
  })
})

describe('withoutReflexive', () => {
  it('drops only the server-reflexive candidates', () => {
    const sdp = [
      'v=0',
      'a=candidate:1 1 udp 2130706431 10.0.0.5 40000 typ host',
      'a=candidate:2 1 udp 1694498815 64.38.144.146 40000 typ srflx raddr 10.0.0.5 rport 40000',
      'a=end-of-candidates',
      ''
    ].join('\r\n')
    expect(withoutReflexive(sdp).split('\r\n')).toEqual([
      'v=0',
      'a=candidate:1 1 udp 2130706431 10.0.0.5 40000 typ host',
      'a=end-of-candidates',
      ''
    ])
  })
})
