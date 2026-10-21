// How clients outside a NAT (a container's published ports, a proxy) reach this daemon (computer-use.md §3.8).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { urlHost } from './http-server.js'

export interface AddressConfig {
  port: number
  publicUrl?: string | undefined
  rtcAddress?: string | undefined
}

/** The base URL clients use from outside, when one is configured: the public URL, else the RTC address on this port. */
export function publicBaseUrl(config: AddressConfig): string | undefined {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '')
  if (config.rtcAddress) return `http://${urlHost(config.rtcAddress)}:${config.port}`
  return undefined
}

/** The only ICE host candidate: the RTC address, else the public URL's host as an IPv4 address; undefined keeps local ones. */
export async function rtcAdvertiseAddress(
  config: AddressConfig,
  resolve: (host: string) => Promise<string> = async (host) => (await lookup(host, { family: 4 })).address,
  log: (line: string) => void = () => undefined
): Promise<string | undefined> {
  if (config.rtcAddress) return config.rtcAddress
  if (!config.publicUrl) return undefined
  const host = new URL(config.publicUrl).hostname.replace(/^\[(.*)\]$/, '$1')
  if (isIP(host)) return host
  try {
    return await resolve(host)
  } catch (error) {
    log(`cannot resolve ${host} for WebRTC (${(error as Error).message}); set RTC_ADDRESS to the public IP`)
    return undefined
  }
}
