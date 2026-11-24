import { useEffect, useState } from 'react';
import { Z } from '../lib/z-index';

/** Presses are ignored for this long after the question appears, so a tap already on its way to something else cannot confirm it. */
export const KEEP_INVITE_CONFIRM_ARM_MS = 500;

/**
 * Asked before a `keep-invite` link from another app opens one of the owner's Keeps. Opening a Keep reads and sends
 * messages over that Keep's relays, so another app does not get to do it unasked. Only the Keep's name the owner knows it
 * by and the game's name from the allowlist are shown: nothing the link itself says.
 */
export const KEEP_INVITE_CONFIRM_COPY = {
  eyebrow: 'Keep',
  title: 'Open your Keep?',
  body: (keepName: string, gameName: string) => `A game asked to open ${keepName} so you can invite someone to play ${gameName}.`,
  open: 'Open Keep',
  later: 'Not now',
} as const;

interface Props {
  keepName: string;
  gameName: string;
  onOpen: () => void;
  onLater: () => void;
}

export function KeepInviteConfirm({ keepName, gameName, onOpen, onLater }: Props) {
  const copy = KEEP_INVITE_CONFIRM_COPY;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), KEEP_INVITE_CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="keep-invite-confirm-title"
      data-testid="keep-invite-confirm"
      style={{ position: 'fixed', inset: 0, zIndex: Z.modal, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16 }}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card)', borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'var(--shadow-lg)' }}
      >
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            {copy.eyebrow}
          </div>
          <h2 id="keep-invite-confirm-title" style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.3 }}>{copy.title}</h2>
        </div>
        <p style={{ margin: 0 }}>{copy.body(keepName, gameName)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-primary" disabled={!armed} onClick={() => { if (armed) onOpen(); }}>{copy.open}</button>
          <button type="button" className="btn btn-ghost" disabled={!armed} onClick={() => { if (armed) onLater(); }}>{copy.later}</button>
        </div>
      </div>
    </div>
  );
}
