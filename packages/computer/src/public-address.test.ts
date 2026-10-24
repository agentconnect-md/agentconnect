import { describe, expect, it } from 'vitest'
import { publicBaseUrl, rtcAdvertiseAddress } from './public-address.js'

describe('public address', () => {
  it('prints the public URL, else the RTC address on the listening port', () => {
    expect(publicBaseUrl({ port: 7681, publicUrl: 'https://desk.example.com/a/', rtcAddress: '203.0.113.5' })).toBe(
      'https://desk.example.com/a'
    )
    expect(publicBaseUrl({ port: 7681, rtcAddress: '203.0.113.5' })).toBe('http://203.0.113.5:7681')
    expect(publicBaseUrl({ port: 7681, rtcAddress: '2001:db8::1' })).toBe('http://[2001:db8::1]:7681')
    expect(publicBaseUrl({ port: 7681 })).toBeUndefined()
  })

  it('offers the RTC address, else the public host, as the only candidate', async () => {
    const resolve = async (host: string) =>
      host === 'desk.example.com' ? '198.51.100.7' : Promise.reject(new Error('nx'))
    expect(await rtcAdvertiseAddress({ port: 1, rtcAddress: '203.0.113.5', publicUrl: 'http://x' }, resolve)).toBe(
      '203.0.113.5'
    )
    expect(await rtcAdvertiseAddress({ port: 1, publicUrl: 'http://192.0.2.4:8080' }, resolve)).toBe('192.0.2.4')
    expect(await rtcAdvertiseAddress({ port: 1, publicUrl: 'http://[2001:db8::2]:80' }, resolve)).toBe('2001:db8::2')
    expect(await rtcAdvertiseAddress({ port: 1, publicUrl: 'https://desk.example.com' }, resolve)).toBe('198.51.100.7')
    const logs: string[] = []
    expect(
      await rtcAdvertiseAddress({ port: 1, publicUrl: 'https://nowhere.test' }, resolve, (l) => logs.push(l))
    ).toBe(undefined)
    expect(logs[0]).toMatch(/RTC_ADDRESS/)
    expect(await rtcAdvertiseAddress({ port: 1 }, resolve)).toBeUndefined()
  })
})
