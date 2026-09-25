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

/**
 * Reject hostnames that resolve to (or are literally) private, loopback,
 * link-local, unique-local, or cloud-metadata addresses, plus the `localhost`
 * family. Returns true for "do NOT connect to this host".
 */
/** Reconstruct a dotted IPv4 from two 16-bit hextets (URL-normalized v4-mapped form). */
function v4FromHextets(hiHex: string, loHex: string): string {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

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

  // IPv6.
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;             // loopback / unspecified
    const first = h.split(':')[0];
    if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true;     // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]$/.test(first)) return true;       // fe80::/10 link-local
    // IPv4-mapped (::ffff:a.b.c.d). The WHATWG URL parser normalizes the dotted
    // tail to the hex form ::ffff:HHHH:HHHH, so handle BOTH and classify the
    // embedded v4 (security audit re-review 2026-06-15 — the dotted-only match
    // never fired for real URL.hostname input).
    const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
    const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) return isPrivateIPv4(v4FromHextets(mappedHex[1], mappedHex[2]));
    // Deprecated IPv4-compatible form (::a.b.c.d → normalized ::HHHH:HHHH).
    const compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (compatHex) return isPrivateIPv4(v4FromHextets(compatHex[1], compatHex[2]));
    const compatDotted = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (compatDotted) return isPrivateIPv4(compatDotted[1]);
    return false; // other global IPv6 — can't enumerate, allow
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
