/**
 * SSRF / internal-network guard for outbound URLs (security audit 2026-06-15).
 *
 * The app fetches contact- and profile-controlled URLs (Blossom avatar blobs,
 * kind-0 picture/banner URLs). Those values are signature-verified for
 * authorship but the URL CONTENT is attacker-influenced: a contact who shared
 * an avatar key can publish a pointer at `https://169.254.169.254/...`, and on
 * passive render the victim's browser would issue a GET to that internal host
 * from inside the victim's network — an SSRF/IP-probe primitive even though the
 * SHA-256 check later rejects the (non-matching) bytes.
 *
 * Client-side we cannot do full DNS-rebind protection, but we CAN block literal
 * private/loopback/link-local/metadata IPs and obvious-internal hostnames. That
 * closes the cheap path. This is intentionally conservative: anything we can't
 * positively classify as a public host (bare integer hosts, hex/octal IP
 * literals, malformed dotted quads) is treated as internal and rejected.
 */

/** True when an IPv4 dotted-quad falls in a private/loopback/link-local/CGNAT range. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** Parse an IPv6 literal (no brackets, no zone) to its 16 bytes, or null. */
function parseIPv6(h: string): number[] | null {
  let text = h;
  // Embedded dotted-quad tail (::ffff:1.2.3.4) becomes two hextets.
  const dotted = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[2].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (head === null || tail === null) return null;
  let hextets: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    hextets = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    hextets = head;
  }
  const bytes: number[] = [];
  for (const x of hextets) bytes.push(x >> 8, x & 0xff);
  return bytes;
}

/** True when a 16-byte IPv6 address is not a public unicast address. */
function isInternalIPv6(b: number[]): boolean {
  const v4 = (o: number[]) => isPrivateIPv4(o.join('.'));
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if ((b[0] & 0xfe) === 0xfc) return true;                       // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;      // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;      // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true;                                // ff00::/8 multicast
  // NAT64: 64:ff9b::/96 and 64:ff9b:1::/48. Refused outright, whatever v4 is embedded.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every((x) => x === 0)) return true;
    if (b[4] === 0x00 && b[5] === 0x01) return true;
  }
  // 6to4 2002::/16: the v4 address sits in bits 16-48.
  if (b[0] === 0x20 && b[1] === 0x02) return v4(b.slice(2, 6));
  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return v4(b.slice(12));
  if (b.slice(0, 12).every((x) => x === 0)) return v4(b.slice(12));
  return false; // other global IPv6 - cannot enumerate, allow
}

/**
 * Reject hostnames that resolve to (or are literally) private, loopback,
 * link-local, unique-local, or cloud-metadata addresses, plus the `localhost`
 * family. Returns true for "do NOT connect to this host".
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return true;
  let h = hostname.toLowerCase();
  // URL.hostname wraps IPv6 literals in brackets — strip them.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Strip a single FQDN-root trailing dot (`localhost.`, `127.0.0.1.`) — the
  // resolver treats it identically, but string/IP checks would otherwise miss it.
  if (h.endsWith('.')) h = h.slice(0, -1);

  // Internal-name shortcuts.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv6. Parsed to 16 bytes and classified by range, so every spelling the
  // URL parser can emit (compressed, hex-tail v4, mixed case) lands on the same
  // answer. An address we cannot parse is treated as internal.
  if (h.includes(':')) {
    const b = parseIPv6(h);
    return b === null ? true : isInternalIPv6(b);
  }

  // Dotted IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);

  // Non-dotted numeric / hex / octal host (e.g. 2130706433, 0x7f000001,
  // 017700000001) — these are alternate encodings of IP literals that some
  // resolvers accept. No legitimate avatar host looks like this; block.
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h) || /^0[0-7]+$/.test(h)) return true;

  // Dotted forms with hex/octal octets (e.g. 0x7f.0.0.1) — any octet that
  // isn't plain decimal in a 4-part dotted host is suspicious; block.
  if (h.includes('.') && /(^|\.)(0x[0-9a-f]+|0[0-7]+)(\.|$)/.test(h)) return true;

  return false;
}
