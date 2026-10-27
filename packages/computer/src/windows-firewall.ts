// Windows Firewall for the daemon's Node: WebRTC media arrives as inbound UDP even when MCP listens on loopback only.
import { spawn } from 'node:child_process'

export const FIREWALL_RULE = 'AgentConnect Computer (Node.js)'

export interface FirewallRules {
  allow: { name: string; profile: string }[]
  block: { name: string; profile: string }[]
  activeProfiles: string[]
}

export type FirewallVerdict =
  | { state: 'allowed'; profiles: string[] }
  | { state: 'blocked'; rules: string[] }
  | { state: 'missing' }
  | { state: 'uncovered'; networks: string[] }

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

// NetworkCategory names (Public/Private/DomainAuthenticated) against rule profiles (Any, or Domain/Private/Public).
export const profileCovered = (profile: string, category: string): boolean =>
  profile === 'Any' || profile.split(/,\s*/).includes(category === 'DomainAuthenticated' ? 'Domain' : category)

// Block rules win over allow rules, so one of them is the answer whatever else is there.
export function firewallVerdict(rules: FirewallRules): FirewallVerdict {
  if (rules.block.length > 0) return { state: 'blocked', rules: rules.block.map((rule) => rule.name) }
  if (rules.allow.length === 0) return { state: 'missing' }
  const networks = rules.activeProfiles.filter(
    (category) => !rules.allow.some((rule) => profileCovered(rule.profile, category))
  )
  if (networks.length > 0) return { state: 'uncovered', networks }
  return { state: 'allowed', profiles: rules.allow.map((rule) => rule.profile) }
}

// Inbound rules for this node.exe, matched by expanded path because prompt-created rules may differ in case.
const readScript = (program: string): string => `$ErrorActionPreference = 'SilentlyContinue'
$p = ${psQuote(program)}
$rules = @(Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { "$($_.Enabled)" -eq 'True' -and "$($_.Direction)" -eq 'Inbound' } | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; action = "$($_.Action)"; profile = "$($_.Profile)" } })
$profiles = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })
ConvertTo-Json -Compress -InputObject @{ rules = $rules; profiles = $profiles }`

export function parseFirewallRules(stdout: string): FirewallRules | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      rules: { name: string; action: string; profile: string }[] | null
      profiles: string[] | null
    }
    const rules = parsed.rules ?? []
    return {
      allow: rules.filter((rule) => rule.action === 'Allow'),
      block: rules.filter((rule) => rule.action === 'Block'),
      activeProfiles: [...new Set(parsed.profiles ?? [])]
    }
  } catch {
    return undefined
  }
}

// One program-scoped rule on every profile; block rules (from Cancel on Windows' own prompt) would override it.
export const allowScript = (program: string): string => `$p = ${psQuote(program)}
Get-NetFirewallRule -DisplayName ${psQuote(FIREWALL_RULE)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p } | Get-NetFirewallRule | Where-Object { "$($_.Action)" -eq 'Block' -and "$($_.Direction)" -eq 'Inbound' } | Disable-NetFirewallRule
New-NetFirewallRule -DisplayName ${psQuote(FIREWALL_RULE)} -Direction Inbound -Program $p -Action Allow -Profile Any | Out-Null`

// Async so the SYSTEM daemon's menu refresh never blocks its event loop on PowerShell's slow start.
function powershell(script: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', () => resolve({ ok: false, stdout }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout })
    })
  })
}

export async function readFirewall(program: string): Promise<FirewallVerdict | undefined> {
  const result = await powershell(readScript(program), 30_000)
  const rules = result.ok ? parseFirewallRules(result.stdout) : undefined
  return rules && firewallVerdict(rules)
}

// The SYSTEM service adds the rule itself; anyone else goes through one UAC prompt.
export async function allowFirewall(program: string, elevated: boolean): Promise<boolean> {
  if (elevated) return (await powershell(allowScript(program), 60_000)).ok
  const encoded = Buffer.from(allowScript(program), 'utf16le').toString('base64')
  const result = await powershell(
    `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    180_000
  )
  return result.ok
}
