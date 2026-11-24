import { useCallback, useEffect, useRef, useState } from 'react';
import { loadStoredKeeps } from '../lib/keep-service';
import { loadNicknames } from '../lib/keep-nicknames';
import { keepGameName } from '../lib/keep-games';
import {
  KEEP_INVITE_EXPIRED, KEEP_INVITE_NOT_YOURS, KEEP_INVITE_OWN_ACCOUNT, KEEP_INVITE_UNREADABLE, decideHeldKeepInvite,
} from '../lib/keep-invite-link';
import type { KeepInviteRoute } from '../lib/native-url';

export interface KeepInviteConfirm {
  invite: KeepInviteRoute;
  /** The exact URL the link arrived as, handed back to `onSettled`. */
  url?: string;
  /** The owner's own name for the Keep (their nickname, else the saved name). The caller's text is never shown here. */
  keepName: string;
  /** From the allowlist. */
  gameName: string;
}

export interface KeepInviteLinkInput {
  /** Identity or preferences still loading. */
  loading: boolean;
  hasIdentity: boolean;
  pairedChild: boolean;
  /** Acting for a dependant, or as a child: Keeps are not managed there. */
  dependantActive: boolean;
  /** The app is unlocked and the saved identity is open. */
  unlocked: boolean;
  /** A PIN prompt, sign-in or signing approval, or other prompt that must come first is showing. The link waits for it to go. */
  otherPromptOpen?: boolean;
  encryptionKey: string | null;
  identityId?: string;
  /** No account or a paired child: the app's existing "nothing to open" answer. */
  onRefused: () => void;
  /** The owner pressed "Open Keep": go to My Keep. */
  onOpen: () => void;
  /** The link is finished with (opened, declined, dropped or refused): forget that exact URL (and only that one) so it can be tried again. */
  onSettled: (url?: string) => void;
}

/**
 * Holds a `keep-invite` link until the app is ready, then asks the owner whether to open that Keep. Nothing is sent and
 * no relay is contacted on the way: the only thing read is the saved Keeps on this phone. `pending` is set only by
 * `accept` (the owner's press) and is what My Keep opens pre-filled.
 */
export function useKeepInviteLink(i: KeepInviteLinkInput) {
  const [held, setHeld] = useState<{ invite: KeepInviteRoute; at: number; url?: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [confirm, setConfirm] = useState<KeepInviteConfirm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<(KeepInviteRoute & { at: number }) | null>(null);
  const busyRef = useRef(false);
  busyRef.current = reading || !!confirm;
  const { otherPromptOpen } = i;
  const { loading, hasIdentity, pairedChild, dependantActive, unlocked, encryptionKey, identityId, onSettled, onOpen, onRefused } = i;

  // While a question is open (or being prepared) a further link is dropped, not queued and not swapped in: the owner
  // answers about the Keep they were just shown.
  const hold = useCallback((invite: KeepInviteRoute, url?: string) => {
    if (busyRef.current) { onSettled(url); return; }
    setHeld({ invite, at: Date.now(), url });
  }, [onSettled]);

  const settleWith = useCallback((text: string, url?: string) => { setNotice(text); onSettled(url); }, [onSettled]);

  useEffect(() => {
    if (!held || reading) return;
    const d = decideHeldKeepInvite({ arrivedAt: held.at, now: Date.now(), loading, hasIdentity, pairedChild, dependantActive, unlocked });
    if (d === 'wait' || (d === 'read' && otherPromptOpen)) return;
    const link = held;
    if (d !== 'read') {
      setHeld(null);
      if (d === 'refuse') { onRefused(); onSettled(link.url); return; }
      settleWith(d === 'expired' ? KEEP_INVITE_EXPIRED : KEEP_INVITE_OWN_ACCOUNT, link.url);
      return;
    }
    setHeld(null);
    setReading(true);
    void loadStoredKeeps(encryptionKey as string).then(list => {
      const keep = list.find(k => k.keep === link.invite.keep);
      if (!keep) { settleWith(KEEP_INVITE_NOT_YOURS, link.url); return; }
      const nickname = identityId ? loadNicknames(identityId)[keep.keep] : undefined;
      setConfirm({ invite: link.invite, url: link.url, keepName: nickname || keep.name, gameName: keepGameName(link.invite.game) ?? 'a game' });
    }, () => { settleWith(KEEP_INVITE_UNREADABLE, link.url); }).finally(() => setReading(false));
  }, [held, reading, loading, hasIdentity, pairedChild, dependantActive, unlocked, otherPromptOpen, encryptionKey, identityId, settleWith, onRefused, onSettled]);

  // The owner's Keep name is private: it is not left on screen if the app locks. The link is let go, so tapping it again
  // after the unlock asks again.
  useEffect(() => {
    if (confirm && !unlocked) { setConfirm(null); onSettled(confirm.url); }
  }, [confirm, unlocked, onSettled]);

  const accept = useCallback(() => {
    if (!confirm) return;
    setPending({ ...confirm.invite, at: Date.now() });
    setConfirm(null);
    onSettled(confirm.url);
    onOpen();
  }, [confirm, onOpen, onSettled]);
  const decline = useCallback(() => { setConfirm(null); onSettled(confirm?.url); }, [confirm, onSettled]);

  return {
    hold, confirm, accept, decline, notice, dismissNotice: () => setNotice(null),
    pending, clearPending: () => setPending(null),
    /** A link is waiting only for the app to be unlocked. */
    waitingForUnlock: !!held && !loading && hasIdentity && !pairedChild && !dependantActive && !unlocked,
  };
}
