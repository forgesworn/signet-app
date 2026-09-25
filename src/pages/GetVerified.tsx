import { useState, useEffect } from 'react';
import { QRScanner } from '../components/QRScanner';
import { useCamera } from '../hooks/useCamera';
import * as db from '../lib/db';
import type { StoredCredential } from '../types';
import { usePublishCredential } from '../hooks/usePublishCredential';
import { toRecoveryWords } from '../lib/recovery-words';
import { RecoveryWordsGrid } from '../components/RecoveryWordsGrid';

interface Props {
  identity: {
    mnemonic: string;
    backedUp?: boolean;
  };
  onMarkBackedUp: () => void;
  relayUrl?: string;
  encryptionKey?: string | null;
  /**
   * Whether to offer the optional "Publish to Nostr relay" button after
   * receiving credentials. False in dependant context so a child's
   * pubkey → tier mapping is never put on a public relay (UK GDPR / AADC).
   * Defaults to true for the guardian's own get-verified flow.
   */
  allowPublish?: boolean;
  /** DEV only — allows e2e tests to inject saved-credential state without going through full QR flow */
  onRegisterSavedInjector?: (fn: (eventJsons: string[]) => void) => void;
}

type Phase = 'education' | 'backup' | 'with-verifier' | 'receive-credentials';

export function GetVerified({ identity, onMarkBackedUp, relayUrl, encryptionKey, allowPublish = true, onRegisterSavedInjector }: Props) {
  const [phase, setPhase] = useState<Phase>('education');
  const [backedUpChecked, setBackedUpChecked] = useState(false);

  // QR scanner state for verifier scan
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [verifierConnected, setVerifierConnected] = useState(false);
  const { hasPermission, error: cameraError, requestPermission } = useCamera();

  // QR scanner state for credential receive
  const [credScanning, setCredScanning] = useState(false);
  const [credScanError, setCredScanError] = useState('');
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [savedEventJsons, setSavedEventJsons] = useState<string[]>([]);
  const { publish, publishing, published, error: publishError } = usePublishCredential(relayUrl);

  useEffect(() => {
    if (phase !== 'backup') return;
    const timer = setTimeout(() => setPhase('with-verifier'), 90_000);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (!onRegisterSavedInjector) return;
    onRegisterSavedInjector((eventJsons) => {
      setSavedEventJsons(eventJsons);
      setCredentialSaved(true);
      setPhase('receive-credentials');
    });
  }, [onRegisterSavedInjector]);

  const handleEnterDetails = () => {
    if (!identity.backedUp) {
      setPhase('backup');
    } else {
      setPhase('with-verifier');
    }
  };

  const handleBackupContinue = () => {
    onMarkBackedUp();
    setPhase('with-verifier');
  };

  const handleScanVerifier = async () => {
    setScanError('');
    if (hasPermission === null || hasPermission === false) {
      await requestPermission();
    }
    setScanning(true);
  };

  const handleVerifierScan = (data: string) => {
    setScanning(false);
    try {
      const payload = JSON.parse(data) as unknown;
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as Record<string, unknown>)['type'] !== 'signet-verifier-v1' ||
        typeof (payload as Record<string, unknown>)['pubkey'] !== 'string'
      ) {
        setScanError('Invalid verifier QR code. Ask your verifier to show their Signet QR.');
        return;
      }
      const pubkey = (payload as Record<string, unknown>)['pubkey'] as string;
      if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
        setScanError('Verifier pubkey is not valid. Please try again.');
        return;
      }
      setVerifierConnected(true);
    } catch {
      setScanError('Could not read QR code. Please try again.');
    }
  };

  const handleCredentialScan = async (data: string) => {
    setCredScanning(false);
    // M2: saveCredential now throws without a key rather than silently
    // persisting the credential body in cleartext. This screen should
    // only be reachable unlocked, but guard explicitly with a clear
    // message rather than falling through to the generic QR-read error.
    if (!encryptionKey) {
      setCredScanError('Please unlock Signet before scanning a credential.');
      return;
    }
    try {
      const payload = JSON.parse(data) as unknown;
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as Record<string, unknown>)['type'] !== 'signet-credentials-v1'
      ) {
        setCredScanError('Invalid credential QR code. Ask your verifier to show the credentials QR.');
        return;
      }
      const p = payload as Record<string, unknown>;
      const npCred = p['naturalPerson'] as Partial<StoredCredential> | undefined;
      const personaCred = p['persona'] as Partial<StoredCredential> | undefined;

      if (npCred && npCred.id && npCred.verifierPubkey) {
        const idStr = String(npCred.id);
        const vpStr = String(npCred.verifierPubkey);
        if (!/^[0-9a-f]{64}$/i.test(idStr) || !/^[0-9a-f]{64}$/i.test(vpStr)) {
          setCredScanError('Invalid credential data'); return;
        }
        const cred: StoredCredential = {
          id: idStr,
          documentId: String(npCred.documentId ?? ''),
          keypairType: 'natural-person',
          event: String(npCred.event ?? ''),
          verifierPubkey: vpStr,
          verifiedAt: typeof npCred.verifiedAt === 'number' ? npCred.verifiedAt : Math.floor(Date.now() / 1000),
          verifierStatus: 'pending',
          merkleLeaves: (typeof npCred.merkleLeaves === 'object' && npCred.merkleLeaves !== null && !Array.isArray(npCred.merkleLeaves)) ? npCred.merkleLeaves as Record<string, string> : undefined,
        };
        await db.saveCredential(cred, encryptionKey ?? undefined);
      }
      if (personaCred && personaCred.id && personaCred.verifierPubkey) {
        const pIdStr = String(personaCred.id);
        const pVpStr = String(personaCred.verifierPubkey);
        if (!/^[0-9a-f]{64}$/i.test(pIdStr) || !/^[0-9a-f]{64}$/i.test(pVpStr)) {
          setCredScanError('Invalid credential data'); return;
        }
        const cred: StoredCredential = {
          id: pIdStr,
          documentId: String(personaCred.documentId ?? ''),
          keypairType: 'persona',
          event: String(personaCred.event ?? ''),
          verifierPubkey: pVpStr,
          verifiedAt: typeof personaCred.verifiedAt === 'number' ? personaCred.verifiedAt : Math.floor(Date.now() / 1000),
          verifierStatus: 'pending',
          merkleLeaves: (typeof personaCred.merkleLeaves === 'object' && personaCred.merkleLeaves !== null && !Array.isArray(personaCred.merkleLeaves)) ? personaCred.merkleLeaves as Record<string, string> : undefined,
        };
        await db.saveCredential(cred, encryptionKey ?? undefined);
      }
      const eventJsons: string[] = [];
      if (npCred?.event) eventJsons.push(String(npCred.event));
      if (personaCred?.event) eventJsons.push(String(personaCred.event));
      setSavedEventJsons(eventJsons);
      setCredentialSaved(true);
    } catch {
      setCredScanError('Could not read credential QR code. Please try again.');
    }
  };

  if (phase === 'education') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 4 }}>How verification works</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            Get your identity verified in about 3 minutes.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              {
                number: 1,
                title: 'Enter your details',
                body: 'Add your name, date of birth, and document info in the app',
              },
              {
                number: 2,
                title: 'Visit a verifier',
                body: 'Your GP, solicitor, teacher, accountant, or any registered professional',
              },
              {
                number: 3,
                title: 'They check your ID',
                body: 'Show your passport or driving licence. They confirm your details on their phone.',
              },
              {
                number: 4,
                title: 'Done',
                body: 'Takes about 3 minutes.',
              },
            ].map((step, i, arr) => (
              <div
                key={step.number}
                style={{
                  display: 'flex',
                  gap: 16,
                  padding: '16px 0',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    color: 'var(--on-accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: '0.9rem',
                  }}
                >
                  {step.number}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{step.title}</div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{step.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleEnterDetails}>
            Enter my details
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'backup') {
    // Recovery words are the typed envelope around the stored BIP-39 mnemonic.
    // An nsec-imported identity has no mnemonic and shows nothing.
    let words: string[] = [];
    if (identity.mnemonic) {
      try {
        words = toRecoveryWords(identity.mnemonic).split(' ');
      } catch {
        words = [];
      }
    }

    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Before you verify</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            You're about to tie your real identity to this account. Before you do, let's secure it properly.
          </p>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
            19 words. Write them down in order. They restore your whole Signet — every persona and dependant — on a new phone or a family Heartwood.
          </p>
          <RecoveryWordsGrid words={words} />

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              cursor: 'pointer',
              marginBottom: 20,
              fontSize: '0.9rem',
            }}
          >
            <input
              type="checkbox"
              checked={backedUpChecked}
              onChange={e => setBackedUpChecked(e.target.checked)}
              style={{ width: 18, height: 18, flexShrink: 0, cursor: 'pointer' }}
            />
            I've written these down somewhere safe
          </label>

          <button
            className="btn btn-primary"
            onClick={handleBackupContinue}
            disabled={!backedUpChecked}
            style={{ opacity: backedUpChecked ? 1 : 0.5, cursor: backedUpChecked ? 'pointer' : 'not-allowed' }}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'receive-credentials') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Receive credentials</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            Waiting for credentials from your verifier. When they show you the credentials QR, tap the button below.
          </p>

          {credentialSaved ? (
            <div>
              <div
                style={{
                  padding: '16px',
                  background: 'var(--success-light)',
                  border: '1px solid var(--success)',
                  borderRadius: 'var(--radius)',
                  color: 'var(--success)',
                  fontWeight: 600,
                  textAlign: 'center',
                  marginBottom: relayUrl && allowPublish ? 16 : 0,
                }}
              >
                Verified! Your credentials have been saved.
              </div>

              {relayUrl && allowPublish && (
                <div style={{ marginTop: 8 }}>
                  {published ? (
                    <p style={{ color: 'var(--success)', fontWeight: 600, textAlign: 'center' }}>
                      Published
                    </p>
                  ) : (
                    <>
                      <button
                        className="btn btn-secondary"
                        disabled={publishing}
                        onClick={async () => {
                          for (const evJson of savedEventJsons) {
                            const ok = await publish(evJson);
                            if (!ok) break;
                          }
                        }}
                        style={{ width: '100%' }}
                      >
                        {publishing ? 'Publishing…' : 'Publish to Nostr relay'}
                      </button>
                      {publishError && (
                        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 8 }}>
                          {publishError}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              {credScanError && (
                <div
                  style={{
                    padding: '12px',
                    background: 'var(--danger-light)',
                    border: '1px solid var(--danger)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--danger)',
                    fontSize: '0.9rem',
                    marginBottom: 16,
                  }}
                >
                  {credScanError}
                </div>
              )}

              {credScanning ? (
                <div style={{ marginBottom: 16 }}>
                  <QRScanner active={credScanning} onScan={handleCredentialScan} />
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setCredScanning(false); setCredScanError(''); }}
                    style={{ marginTop: 12 }}
                    aria-label="Cancel QR scan"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => { setCredScanError(''); setCredScanning(true); }}
                >
                  Scan credential QR
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // phase === 'with-verifier'
  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>I'm with my verifier</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          Ask them to show you their verifier QR code on their phone.
        </p>

        {verifierConnected ? (
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                padding: '12px 16px',
                background: 'var(--success-light)',
                border: '1px solid var(--success)',
                borderRadius: 'var(--radius)',
                color: 'var(--success)',
                fontSize: '0.9rem',
                marginBottom: 16,
              }}
            >
              Connected to verifier. Your details have been sent. Wait for them to confirm.
            </div>
            <button
              className="btn btn-primary"
              onClick={() => setPhase('receive-credentials')}
            >
              Receive credentials
            </button>
          </div>
        ) : (
          <>
            {cameraError && (
              <div
                style={{
                  padding: '12px',
                  background: 'var(--danger-light)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--danger)',
                  fontSize: '0.9rem',
                  marginBottom: 16,
                }}
              >
                {cameraError}
              </div>
            )}

            {scanError && (
              <div
                style={{
                  padding: '12px',
                  background: 'var(--danger-light)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--danger)',
                  fontSize: '0.9rem',
                  marginBottom: 16,
                }}
              >
                {scanError}
              </div>
            )}

            {scanning ? (
              <div style={{ marginBottom: 16 }}>
                <QRScanner active={scanning} onScan={handleVerifierScan} />
                <button
                  className="btn btn-ghost"
                  onClick={() => { setScanning(false); setScanError(''); }}
                  style={{ marginTop: 12 }}
                  aria-label="Cancel QR scan"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleScanVerifier}
                style={{ marginBottom: 16 }}
              >
                Scan verifier's QR
              </button>
            )}
          </>
        )}

        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          This will send your details to their app for confirmation.
        </p>

        {allowPublish && (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 24 }}>
            After receiving your credentials, you can publish them to the Nostr network so other apps
            can see your verification. This is optional — configure a relay in Settings → Power Mode.
          </p>
        )}
      </div>
    </div>
  );
}
