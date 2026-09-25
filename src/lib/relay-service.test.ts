import { describe, it, expect, vi } from 'vitest';

async function freshRelayService() {
  vi.resetModules();
  return await import('./relay-service');
}

describe('setRelayUrl validation', () => {
  it('accepts wss:// URLs', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('wss://relay.example.com')).not.toThrow();
  });

  it('accepts ws://localhost', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('ws://localhost:7777')).not.toThrow();
  });

  it('accepts ws://127.0.0.1', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('ws://127.0.0.1:7777')).not.toThrow();
  });

  it('rejects http:// URLs', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('http://relay.example.com')).toThrow('wss://');
  });

  it('rejects ws:// for non-localhost', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('ws://relay.example.com')).toThrow('wss://');
  });

  it('rejects bare strings', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('relay.example.com')).toThrow('wss://');
  });

  it('case-insensitive scheme check', async () => {
    const rs = await freshRelayService();
    expect(() => rs.setRelayUrl('WSS://relay.example.com')).not.toThrow();
  });
});

describe('getRelayUrl', () => {
  it('returns current URL after setRelayUrl', async () => {
    const rs = await freshRelayService();
    rs.setRelayUrl('wss://new-relay.example.com');
    expect(rs.getRelayUrl()).toBe('wss://new-relay.example.com');
  });
});

describe('defaultRelays', () => {
  it('returns trotters.cc primary (write) + 5 public, nostr.band read-only', async () => {
    const rs = await freshRelayService();
    const d = rs.defaultRelays();
    expect(d).toHaveLength(6);
    expect(d[0]).toMatchObject({ enabled: true, read: true, write: true }); // primary
    const band = d.find(r => r.url === 'wss://relay.nostr.band');
    expect(band).toMatchObject({ enabled: true, read: true, write: false });
    expect(d.filter(r => r.write).length).toBe(5); // trotters + nos.lol + damus + primal + ditto
  });
});

describe('primaryRelayUrl', () => {
  it('picks the first enabled+write relay', async () => {
    const rs = await freshRelayService();
    const url = rs.primaryRelayUrl([
      { url: 'wss://read.example', enabled: true, read: true, write: false },
      { url: 'wss://write.example', enabled: true, read: true, write: true },
    ]);
    expect(url).toBe('wss://write.example');
  });
  it('falls back to first enabled when none are write', async () => {
    const rs = await freshRelayService();
    const url = rs.primaryRelayUrl([
      { url: 'wss://r1.example', enabled: false, read: true, write: true },
      { url: 'wss://r2.example', enabled: true, read: true, write: false },
    ]);
    expect(url).toBe('wss://r2.example');
  });
  it('falls back to DEFAULT_RELAY_URL when nothing is enabled', async () => {
    const rs = await freshRelayService();
    expect(rs.primaryRelayUrl([])).toBe(rs.DEFAULT_RELAY_URL);
  });
});

describe('DEFAULT_RELAY_URL under Capacitor', () => {
  it('never selects the dev relay when Capacitor reports native', async () => {
    // Capacitor serves the app from https://localhost — simulate that origin
    // plus a native-platform report, and re-import so the module-level
    // constant is recomputed against the stubbed window.
    vi.stubGlobal('window', {
      location: { hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true },
    });
    try {
      const rs = await freshRelayService();
      expect(rs.DEFAULT_RELAY_URL).toBe('wss://relay.trotters.cc');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
