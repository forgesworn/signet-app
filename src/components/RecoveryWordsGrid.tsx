import { recoveryWordRole } from '../lib/recovery-words';

interface Props {
  /** Already-split recovery words, in order. Empty for an identity with no mnemonic. */
  words: string[];
  /**
   * Drop the card wrapper. Security settings already renders this inside its
   * own card, and nesting two would read as a mistake.
   */
  bare?: boolean;
}

/**
 * The numbered recovery-words grid.
 *
 * Extracted verbatim from `GetVerified`'s "Before you verify" phase so the
 * activation page can show the same thing (spec §7.1 step 4). Presentation
 * only — it renders whatever it is given, holds no timers, and offers no
 * clipboard copy.
 *
 * The 90 s auto-hide and the fresh-auth gate live on the SURFACES that host it,
 * because each hides the words differently. All three DO hide them: Security
 * settings gates on fresh auth, copies to the clipboard and hides the card; Get
 * Verified advances its phase off the words; activation hides them in place
 * behind a "Show them again" tap. None of that belongs here — one grid serves
 * all three.
 *
 * A typed envelope is split into its two parts and labelled. The first seven
 * words are format: magic and version fill words 1-2 entirely, so EVERY Signet
 * backup opens "edge obtain", and word 3 has 32 possible values. Shown as one
 * undifferentiated list, a fresh backup looks like the last one — an owner
 * comparing two of them concludes their keys repeated (it happened, 2026-09-12,
 * against a Heartwood that was working perfectly). Worse, once they learn to
 * ignore the familiar opening, a genuinely repeated key looks the same. A
 * sequence that is not an envelope falls back to the plain list, because
 * nothing can be said honestly about its shape.
 */
export function RecoveryWordsGrid({ words, bare = false }: Props) {
  const labelled = recoveryWordRole(1, words.length) !== null;
  const headerWords = labelled
    ? words.filter((_, i) => recoveryWordRole(i + 1, words.length) !== 'secret')
    : [];
  const secretWords = labelled
    ? words.filter((_, i) => recoveryWordRole(i + 1, words.length) === 'secret')
    : [];

  return (
    <div className={bare ? undefined : 'card'} style={{ marginBottom: bare ? 12 : 20 }}>
      {labelled ? (
        <>
          <SectionLabel
            title={`Format header — words 1 to ${headerWords.length}`}
            note="Every Signet backup starts the same way. Not your key."
            muted
          />
          <WordGrid words={headerWords} startAt={1} muted />
          <div
            style={{
              height: 1,
              background: 'var(--border)',
              margin: '16px 0',
            }}
          />
          <SectionLabel
            title={`Your key — words ${headerWords.length + 1} to ${words.length}`}
            note="This part is unique to you. Anyone who reads it controls your identity."
          />
          <WordGrid words={secretWords} startAt={headerWords.length + 1} />
        </>
      ) : (
        <WordGrid words={words} startAt={1} />
      )}
    </div>
  );
}

function SectionLabel({
  title,
  note,
  muted = false,
}: {
  title: string;
  note: string;
  muted?: boolean;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: '0.8rem',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 700,
          color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }}>
        {note}
      </div>
    </div>
  );
}

function WordGrid({
  words,
  startAt,
  muted = false,
}: {
  words: string[];
  startAt: number;
  muted?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {words.map((word, i) => (
        <div
          key={i}
          data-word-index={startAt + i}
          style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
        >
          <span
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.85rem',
              width: 20,
              textAlign: 'right',
              flexShrink: 0,
            }}
          >
            {startAt + i}
          </span>
          <span
            style={{
              fontWeight: 600,
              fontSize: '1rem',
              color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
            }}
          >
            {word}
          </span>
        </div>
      ))}
    </div>
  );
}
