// Shared SSRF / outbound network guard for probes and webhooks.
// Blocks loopback, link-local (including cloud IMDS), private RFC1918,
// CGNAT, ULA, multicast/unspecified, and IPv4-mapped IPv6 addresses.
import dns from 'node:dns';
import net from 'node:net';

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIpv4Bytes([a, b]) {
  if (a === 0) return true;                          // 0.0.0.0/8 unspecified
  if (a === 10) return true;                         // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local / IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 RFC1918
  if (a === 192 && b === 0) return true;             // 192.0.0.0/16 IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

// Expand an IPv6 string (including :: and dotted-quad tail) into 8 x 16-bit ints.
function parseIpv6(raw) {
  const ip = raw.split('%')[0].toLowerCase();
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (str) => {
    if (!str) return [];
    const tokens = str.split(':');
    const groups = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const v4 = parseIpv4(tok);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        groups.push(parseInt(tok, 16));
      }
    }
    return groups;
  };

  const left = parseHalf(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseHalf(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

export function isPrivateIp(rawIp) {
  if (typeof rawIp !== 'string') return true;
  const ip = rawIp.trim().replace(/^\[|\]$/g, '');
  const stripped = ip.split('%')[0];
  const family = net.isIP(stripped);
  if (family === 4) {
    const v4 = parseIpv4(stripped);
    return !v4 || isPrivateIpv4Bytes(v4);
  }
  if (family === 6) {
    const g = parseIpv6(stripped);
    if (!g) return true;
    const isAllZeroPrefix = (count) => {
      for (let i = 0; i < count; i++) if (g[i] !== 0) return false;
      return true;
    };
    // Unspecified :: and loopback ::1
    if (isAllZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;
    // IPv4-mapped ::ffff:a.b.c.d (0:0:0:0:0:ffff:xxxx:yyyy)
    if (isAllZeroPrefix(5) && g[5] === 0xffff) {
      return isPrivateIpv4Bytes([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    // IPv4-translated ::ffff:0:a.b.c.d
    if (isAllZeroPrefix(4) && g[4] === 0xffff && g[5] === 0) {
      return isPrivateIpv4Bytes([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    // IPv4-compatible ::a.b.c.d (deprecated)
    if (isAllZeroPrefix(6) && (g[6] !== 0 || g[7] !== 0)) {
      return isPrivateIpv4Bytes([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    // NAT64 well-known prefix 64:ff9b::/96
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIpv4Bytes([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    // Link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // Deprecated site-local fec0::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true;
    // Unique local (ULA) fc00::/7
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // Multicast ff00::/8
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

export function isBlockedHostname(rawHost) {
  if (typeof rawHost !== 'string') return true;
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || /\s/.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') {
    return true;
  }
  const stripped = host.split('%')[0];
  if (net.isIP(stripped)) {
    return isPrivateIp(stripped);
  }
  // Reject integer/octal/hex single-label IP tricks (e.g. 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  return false;
}

export async function assertSafeHost(rawHost, { allowPrivate = false, lookupImpl = dns.promises.lookup, ignoreDnsFailure = false } = {}) {
  if (typeof rawHost !== 'string') throw new Error('invalid host');
  const host = rawHost.trim().replace(/^\[|\]$/g, '');
  if (!host || /[\s/?#@]/.test(host)) throw new Error('invalid host');

  const stripped = host.split('%')[0];
  if (net.isIP(stripped)) {
    if (!allowPrivate && isPrivateIp(stripped)) {
      throw new Error(`blocked private or reserved IP: ${stripped}`);
    }
    return [stripped];
  }

  if (!allowPrivate && isBlockedHostname(host)) {
    throw new Error(`blocked host: ${host}`);
  }

  let records;
  try {
    records = await lookupImpl(host, { all: true });
  } catch (err) {
    if (ignoreDnsFailure) return [];
    throw new Error(`DNS lookup failed: ${err?.code ?? err?.message ?? 'error'}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    if (ignoreDnsFailure) return [];
    throw new Error('DNS lookup returned no addresses');
  }
  const addresses = [];
  for (const r of records) {
    const addr = r?.address;
    if (!addr) continue;
    if (!allowPrivate && isPrivateIp(addr)) {
      throw new Error(`blocked private or reserved IP: ${addr}`);
    }
    addresses.push(addr);
  }
  if (!addresses.length && !ignoreDnsFailure) {
    throw new Error('DNS lookup returned no valid addresses');
  }
  return addresses;
}

export async function assertSafeUrl(rawUrl, opts = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl) throw new Error('invalid URL');
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s) URLs are allowed');
  }
  if (u.username || u.password) {
    throw new Error('URL credentials are not allowed');
  }
  const addresses = await assertSafeHost(u.hostname, opts);
  return { url: u, addresses };
}

export function parseTcpTarget(target) {
  if (typeof target !== 'string') return null;
  const t = target.trim();
  let host;
  let portStr;
  if (t.startsWith('[')) {
    const close = t.indexOf(']:');
    if (close <= 1) return null;
    host = t.slice(1, close);
    portStr = t.slice(close + 2);
  } else {
    const sep = t.lastIndexOf(':');
    if (sep <= 0 || sep === t.length - 1) return null;
    host = t.slice(0, sep);
    portStr = t.slice(sep + 1);
  }
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!host || /[\s/?#@]/.test(host)) return null;
  return { host, port };
}

export async function assertSafeTcpTarget(target, opts = {}) {
  const parsed = parseTcpTarget(target);
  if (!parsed) throw new Error('target must be host:port');
  const addresses = await assertSafeHost(parsed.host, opts);
  return { ...parsed, addresses };
}
