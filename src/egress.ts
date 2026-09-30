import { ProviderError } from './errors.js'

export type EndpointClass = 'local' | 'private' | 'remote'

export type EgressPolicy = 'allow' | 'block-remote-automatic' | 'block-remote-all'

export type CallOrigin = 'explicit' | 'automatic'

const LOOPBACK = new Set(['localhost', '::1', '[::1]', '0.0.0.0'])
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa']

/**
 * IPv4-mapped IPv6 literals (e.g. `::ffff:127.0.0.1`) embed a plain IPv4
 * address. WHATWG URL normalizes them to hexadecimal (`::ffff:7f00:1`), so the
 * embedded address is recovered from the two trailing 16-bit groups.
 * They must be classified from that embedded address, otherwise a loopback or
 * RFC1918 endpoint is wrongly treated as remote and remote-egress policy
 * applies to local traffic.
 */
function unwrapMappedIpv4(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (!m) return null
  const high = Number.parseInt(m[1], 16)
  const low = Number.parseInt(m[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isLoopbackIpv4(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  if (!h.includes(':')) return false
  if (h === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true
  return false
}

export function classifyEndpoint(endpoint: string): EndpointClass {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new ProviderError('configuration', 'Endpoint must be a valid absolute URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ProviderError('configuration', 'Endpoint must use http or https')
  }
  const host = url.hostname.toLowerCase()
  const mapped = unwrapMappedIpv4(host)
  if (mapped !== null) {
    if (isLoopbackIpv4(mapped)) return 'local'
    return isPrivateIpv4(mapped) ? 'private' : 'remote'
  }
  if (LOOPBACK.has(host) || isLoopbackIpv4(host)) return 'local'
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return 'private'
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return 'private'
  return 'remote'
}

export function resolveEndpointClass(endpoint: string, override: unknown): EndpointClass {
  if (override === undefined || override === null || override === '' || override === 'auto') {
    return classifyEndpoint(endpoint)
  }
  if (override === 'local' || override === 'private' || override === 'remote') return override
  throw new ProviderError('configuration', 'Invalid endpoint class override')
}

export function resolveEgressPolicy(value: unknown): EgressPolicy {
  if (value === undefined || value === null || value === '') return 'allow'
  if (value === 'allow' || value === 'block-remote-automatic' || value === 'block-remote-all') {
    return value as EgressPolicy
  }
  throw new ProviderError('configuration', 'Invalid egress policy')
}

export function assertEgressAllowed(
  endpointClass: EndpointClass,
  policy: EgressPolicy,
  origin: CallOrigin,
): void {
  if (endpointClass !== 'remote') return
  if (policy === 'allow') return
  if (policy === 'block-remote-all') {
    throw new ProviderError(
      'egress_blocked',
      'Egress policy forbids sending this content to a remote endpoint',
    )
  }
  if (origin === 'automatic') {
    throw new ProviderError(
      'egress_blocked',
      'Egress policy forbids automatic remote semantic calls for repository or session content',
    )
  }
}
