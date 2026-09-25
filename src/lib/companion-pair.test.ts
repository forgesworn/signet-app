import { describe, it, expect } from 'vitest'
import { parsePairingRequest, parsePairingAck } from './companion-pair'

const APP = 'a'.repeat(64)
const RELAY = 'wss://relay.example.com'
const CHALLENGE = 'f'.repeat(32)
const now = Math.floor(Date.now() / 1000)

function uri(overrides: Record<string, string> = {}) {
  const p = new URLSearchParams({
    app: APP, name: 'My App', scope: 'kith,kin', relay: RELAY,
    t: String(now), challenge: CHALLENGE, ...overrides,
  })
  return `signet-grant://pair?${p.toString()}`
}

describe('parsePairingRequest', () => {
  it('parses a valid request', () => {
    const { request } = parsePairingRequest(uri())
    expect(request).toMatchObject({ appPubkey: APP, appName: 'My App', tiers: ['kith', 'kin'], rendezvousRelay: RELAY })
  })
  it('rejects a bad app pubkey', () => {
    expect(parsePairingRequest(uri({ app: 'xyz' })).request).toBeNull()
  })
  it('rejects a non-wss relay in production', () => {
    expect(parsePairingRequest(uri({ relay: 'http://evil.example.com' })).request).toBeNull()
  })
  it('rejects a stale timestamp', () => {
    expect(parsePairingRequest(uri({ t: String(now - 6 * 60) })).request).toBeNull()
  })
  it('rejects a short challenge', () => {
    expect(parsePairingRequest(uri({ challenge: 'abcd' })).request).toBeNull()
  })
  it('drops unknown scope tokens, warns, keeps valid tiers', () => {
    const { request, warnings } = parsePairingRequest(uri({ scope: 'kin,bogus' }))
    expect(request?.tiers).toEqual(['kin'])
    expect(warnings).toContain('scope-unknown-token')
  })
  it('sanitises and truncates the app name', () => {
    const { request } = parsePairingRequest(uri({ name: 'a'.repeat(100) }))
    expect(request?.appName.length).toBeLessThanOrEqual(64)
  })
  // I4 — the challenge is validated case-insensitively but must round-trip
  // verbatim (byte-for-byte) so the ack echo matches whatever casing the
  // requesting app sent, including an uppercase-hex challenge.
  it('preserves an uppercase-hex challenge verbatim (does not lowercase it)', () => {
    const upperChallenge = CHALLENGE.toUpperCase()
    const { request } = parsePairingRequest(uri({ challenge: upperChallenge }))
    expect(request?.challenge).toBe(upperChallenge)
  })
})

describe('parsePairingAck', () => {
  it('accepts a matching challenge', () => {
    const ack = { v: 1, railPubkey: 'b'.repeat(64), dTag: 'signet:companion-rail', snapshotRelay: RELAY, grantedScope: { tiers: ['kin'], personas: 'all' }, challenge: CHALLENGE }
    expect(parsePairingAck(JSON.stringify(ack), CHALLENGE)).toMatchObject({ railPubkey: 'b'.repeat(64) })
  })
  it('rejects a mismatched challenge', () => {
    const ack = { v: 1, railPubkey: 'b'.repeat(64), dTag: 'signet:companion-rail', snapshotRelay: RELAY, grantedScope: { tiers: ['kin'], personas: 'all' }, challenge: 'other' }
    expect(parsePairingAck(JSON.stringify(ack), CHALLENGE)).toBeNull()
  })
})
