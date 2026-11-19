import type { CSSProperties, ReactNode } from 'react';
import type { PendingApproval } from '../hooks/useBunkerServer';
import { shortNpub } from '../lib/signet';
import { safeAppName, safeUrl, UNKNOWN_APP_NAME } from '../lib/bunker-display';
import {
  absoluteTimeText,
  ageText,
  cryptoRequestLabel,
  declaredNameForDisplay,
  dTagOf,
  hostOf,
  oneLine,
  pairedDateText,
  PREVIEW_MAX_CHARS,
  signRequestLabel,
  summariseContent,
  tagSummary,
} from '../lib/bunker-request-detail';

/**
 * Everything a pending Bunker request holds, as label: value rows. Shared by
 * the panel card's down-arrow and the approval modal's, so the two can never
 * say different things about one request.
 *
 * Every string from the app is hostile (see bunker-request-detail.ts) and is
 * rendered as React text only: no links, no innerHTML.
 */

/** What kind of "app" the card is naming. */
export type AppKind = 'row' | 'pairing' | 'device' | 'none';

type AppSubject = Pick<PendingApproval, 'client' | 'route'>;

/**
 * A saved client row; a dependant's app pairing (named by its label, no row);
 * a dependant's own bound device (no row, no label: it already passed the
 * route's client binding, so it is NOT an unpaired stranger); or an owner-route
 * client with no row, which is the one that reads "Unknown app". Decided from
 * the route and the row, never from the name's text.
 */
export function appKindOf({ client, route }: AppSubject): AppKind {
  if (client.existing) return 'row';
  if (route.dependantId) return route.routeKind === 'app' ? 'pairing' : 'device';
  return 'none';
}

/** The title of a request that comes from a dependant's own paired device. */
export const DEVICE_TITLE = 'Their paired device';

/** The text on line 1 of the card: the app's name. A declared name only ever follows "Unknown app". */
export function appHeadline(subject: AppSubject): { name: string; declared?: string } {
  const { client } = subject;
  const kind = appKindOf(subject);
  if (kind === 'device') return { name: DEVICE_TITLE };
  if (kind !== 'none') return { name: safeAppName(client.appName) };
  return { name: UNKNOWN_APP_NAME, ...(client.declaredName ? { declared: declaredNameForDisplay(client.declaredName) } : {}) };
}

/**
 * The site part of the card's third line, plain text: the saved hostname, or
 * what the app SAYS its site is ("says it's from <host>"), since that url is as
 * unauthenticated as the name.
 */
export function siteLine(client: PendingApproval['client']): string | undefined {
  const saved = hostOf(client.appUrl);
  if (saved) return saved;
  const declared = hostOf(client.declaredUrl);
  return declared ? `says it's from ${declared}` : undefined;
}

/** What a request on a dependant route calls the dependant when its name does not resolve. */
export const DEPENDANT_FALLBACK = 'A dependant';

const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '84px 1fr', gap: 8, fontSize: 12, lineHeight: 1.5 };
const labelStyle: CSSProperties = { color: 'var(--text-muted, var(--text-secondary))' };
const valueStyle: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{children}</span>
    </div>
  );
}

/** The down-arrow button both surfaces use. */
export function DetailToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="More about this request"
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, lineHeight: 0 }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"
        style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}>
        <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

interface Props {
  approval: PendingApproval;
  /** Epoch ms, from the caller's ticker. */
  now: number;
  /** Name of the dependant this request is for, when it is on a dependant route. */
  dependantName?: string;
  /** Display label of the owner persona the request addresses, when known. */
  ownerLabel?: string;
}

export function PendingRequestDetail({ approval, now, dependantName, ownerLabel }: Props) {
  const { client } = approval;
  const kind = appKindOf(approval);
  const savedUrl = safeUrl(client.appUrl);
  const declaredUrl = savedUrl ? null : safeUrl(client.declaredUrl);

  let appValue: ReactNode;
  if (kind === 'row') {
    const paired = typeof client.connectedAt === 'number' ? `Paired ${pairedDateText(client.connectedAt)}` : 'Paired on this phone';
    const seen = typeof client.lastSeenAt === 'number' ? ` · last seen ${ageText(client.lastSeenAt * 1000, now) || 'just now'}` : '';
    appValue = `${paired}${seen}`;
  } else if (kind === 'pairing') {
    appValue = safeAppName(client.appName);
  } else if (kind === 'device') {
    appValue = "The dependant's paired device";
  } else {
    appValue = client.declaredName
      ? `Not paired on this phone (calls itself "${declaredNameForDisplay(client.declaredName)}")`
      : 'Not paired on this phone';
  }

  const identity = approval.route.dependantId
    ? (dependantName ? safeAppName(dependantName) : DEPENDANT_FALLBACK)
    : (
      <>
        {ownerLabel ? `${safeAppName(ownerLabel)} · ` : ''}
        <span style={mono}>{shortNpub(approval.route.pubkey)}</span>
      </>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <Row label="Asked">{typeof approval.askedAt === 'number' ? absoluteTimeText(approval.askedAt, now) : 'Unknown'}</Row>
      <Row label="App">{appValue}</Row>
      <Row label="Site">
        {savedUrl ?? (declaredUrl ? `${declaredUrl} (as the app says)` : 'None given')}
      </Row>
      <Row label="App key"><span style={mono}>{shortNpub(client.pubkey)}</span></Row>
      <Row label="Identity">{identity}</Row>
      {approval.method === 'sign_event' ? <SignRows template={approval.template} /> : <CryptoRows approval={approval} />}
    </div>
  );
}

function SignRows({ template }: { template: Extract<PendingApproval, { method: 'sign_event' }>['template'] }) {
  const label = dTagOf(template.tags);
  const content = summariseContent(template.content);
  return (
    <>
      <Row label="Request">{signRequestLabel(template)}</Row>
      {label && <Row label="Label">{label}</Row>}
      <Row label="Tags">{tagSummary(template.tags)}</Row>
      <Row label="Content">
        {content.kind === 'empty' && 'Empty'}
        {content.kind === 'encrypted' && `Encrypted, ${content.length} characters`}
        {content.kind === 'text' && <SentByApp text={content.preview.text} total={content.preview.total} />}
      </Row>
    </>
  );
}

function CryptoRows({ approval }: { approval: Exclude<PendingApproval, { method: 'sign_event' }> }) {
  const decrypt = approval.method.endsWith('decrypt');
  const self = approval.peerPubkey.toLowerCase() === approval.route.pubkey.toLowerCase();
  return (
    <>
      <Row label="Request">{cryptoRequestLabel(approval.method)}</Row>
      <Row label="With">{self ? 'Yourself' : <span style={mono}>{shortNpub(approval.peerPubkey)}</span>}</Row>
      <Row label="Data">
        {decrypt
          ? `Encrypted, ${approval.payloadLength} characters`
          : approval.payloadLength === 0
            ? 'Empty'
            : <SentByApp text={oneLine(approval.payloadPreview ?? '', PREVIEW_MAX_CHARS)} total={approval.payloadLength} />}
      </Row>
    </>
  );
}

/** A preview of text the app sent, marked as the app's and not ours, with its length. */
function SentByApp({ text, total }: { text: string; total: number }) {
  const cut = total > PREVIEW_MAX_CHARS;
  return (
    <>
      <span style={{ display: 'block' }}>{text}{cut ? '…' : ''}</span>
      <span style={{ display: 'block', color: 'var(--text-secondary)' }}>
        As sent by the app · {cut ? `first ${PREVIEW_MAX_CHARS} of ${total} characters` : `${total} characters`}
      </span>
    </>
  );
}
