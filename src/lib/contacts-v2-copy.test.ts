import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tierChipLabel,
  tierProvenanceSuffix,
  effectiveTierLine,
  blockedLine,
  independenceGateCopy,
  removalChoiceCopy,
  defaultChildCeilingCopy,
  describeDirectories,
  shareConfirmCopy,
  vouchConfirmCopy,
  KEYLESS_MARKER,
  KEYLESS_EXPLAINER,
  GUARDIAN_BLOCK_LOCK_COPY,
  BLOCK_BOUNDARY_COPY,
  CONTACTS_BACKUP_TOO_LARGE_COPY,
  CONTACTS_BACKUP_STALLED_COPY,
  GRANTS_SKIPPED_REMOTE_COPY,
  removeRoleAriaLabel,
  blockConfirmLabel,
  removeContactConfirmCopy,
  addingToContactsCopy,
  CONTACTS_GRANT_CAPABILITY_COPY,
} from './contacts-v2-copy';
import { CAPABILITIES } from '@forgesworn/signet-contacts/wire';

const ME = '1'.repeat(64);
const GUARDIAN = '2'.repeat(64);

describe('tier labels and provenance', () => {
  it('labels every tier and the no-tier case', () => {
    expect(tierChipLabel('kin')).toBe('Kin');
    expect(tierChipLabel('kith')).toBe('Kith');
    expect(tierChipLabel('ken')).toBe('Ken');
    expect(tierChipLabel('none')).toBe('No tier');
  });

  it('adds no suffix to a direct classification', () => {
    expect(tierProvenanceSuffix('direct', 'Joe')).toBeNull();
  });

  it('names the guardian for a vouched tier and falls back when unnamed', () => {
    expect(tierProvenanceSuffix('guardian-vouched', 'Joe')).toBe('via Joe');
    expect(tierProvenanceSuffix('guardian-vouched', null)).toBe('via guardian');
  });

  it('says guardian-limited for a capped tier', () => {
    expect(tierProvenanceSuffix('guardian-limited', 'Joe')).toBe('guardian-limited');
  });

  it('builds the plain-English tier line a dependant reads', () => {
    expect(effectiveTierLine({ effectiveTier: 'kin', tierSource: 'direct' }, 'Joe')).toBe('Kin');
    expect(effectiveTierLine({ effectiveTier: 'kin', tierSource: 'guardian-vouched' }, 'Joe')).toBe(
      'Kin via Joe',
    );
    expect(effectiveTierLine({ effectiveTier: 'ken', tierSource: 'guardian-limited' }, 'Joe')).toBe(
      'Joe limited this to Ken',
    );
    expect(effectiveTierLine({ effectiveTier: 'ken', tierSource: 'guardian-limited' }, null)).toBe(
      'Guardian limited this to Ken',
    );
  });
});

describe('blocked lines', () => {
  it('returns null when the contact is not blocked', () => {
    expect(blockedLine({ blocked: false, blockedBy: [], displayName: 'Dave' }, ME, 'Joe')).toBeNull();
  });

  it('says "Blocked by you" for the actor own block', () => {
    expect(blockedLine({ blocked: true, blockedBy: [ME], displayName: 'Dave' }, ME, 'Joe')).toBe(
      'Blocked by you',
    );
  });

  it('names the guardian and the contact for a guardian block', () => {
    expect(blockedLine({ blocked: true, blockedBy: [GUARDIAN], displayName: 'Dave' }, ME, 'Joe')).toBe(
      'Joe blocked Dave',
    );
    expect(blockedLine({ blocked: true, blockedBy: [GUARDIAN], displayName: 'Dave' }, ME, null)).toBe(
      'Guardian blocked Dave',
    );
  });

  it('mentions both when the actor and a guardian have blocked', () => {
    expect(blockedLine({ blocked: true, blockedBy: [ME, GUARDIAN], displayName: 'Dave' }, ME, 'Joe')).toBe(
      'Blocked by you and by Joe',
    );
  });

  it('strips control characters and bidi overrides from names', () => {
    const malicious = 'Eve‮Joe'; // LRO bidi override: looks like EveJoe but sorts as Eve-RTL-Joe
    const withControl = 'Sam\x00name'; // null byte
    expect(blockedLine({ blocked: true, blockedBy: [GUARDIAN], displayName: malicious }, ME, 'Joe')).toBe(
      'Joe blocked EveJoe',
    );
    expect(blockedLine({ blocked: true, blockedBy: [GUARDIAN], displayName: withControl }, ME, 'Joe')).toBe(
      'Joe blocked Samname',
    );
    expect(effectiveTierLine({ effectiveTier: 'kin', tierSource: 'guardian-vouched' }, 'J‏oe')).toBe(
      'Kin via Joe',
    ); // RLM zero-width
  });
});

describe('gate, removal and ceiling copy', () => {
  it('uses the exact independence gate sentence', () => {
    expect(independenceGateCopy('Sam')).toBe(
      "Contact transfer isn't available yet. Independence will be enabled once contacts can move with Sam.",
    );
  });

  it('describes delete and archive in one sentence each', () => {
    const copy = removalChoiceCopy('Sam');
    expect(copy.deleteLine).toBe(
      "Delete contacts — Sam's contacts are tombstoned on this device and app access to them is revoked; copies already on a relay or inside an app cannot be guaranteed erased.",
    );
    expect(copy.archiveLine).toBe(
      "Archive contacts — Sam's contacts stop syncing and stop being editable, but stay as an encrypted read-only snapshot you can restore or delete later.",
    );
  });

  it('explains the default child ceiling', () => {
    expect(defaultChildCeilingCopy('Sam')).toBe(
      'Contacts Sam adds themselves are capped at this tier until you vouch for them.',
    );
  });
});

describe('bulk-action confirm copy', () => {
  it('lists one, two and many directories', () => {
    expect(describeDirectories(['Sam'])).toBe('Sam');
    expect(describeDirectories(['Sam', 'Lily'])).toBe('Sam and Lily');
    expect(describeDirectories(['You', 'Sam', 'Lily'])).toBe('You, Sam and Lily');
  });

  it('returns "nobody" for an empty directory list', () => {
    expect(describeDirectories([])).toBe('nobody');
  });

  it('names every affected directory in the share confirm', () => {
    expect(shareConfirmCopy('Dave', ['Sam', 'Lily'])).toBe(
      "Add Dave to Sam and Lily as Ken. Only the fields selected below are copied. Shared checks and tier are attributed to you, not treated as their own.",
    );
  });

  it('names every affected directory in the vouch confirm', () => {
    expect(vouchConfirmCopy('Dave', 'kin', ['You', 'Sam'])).toBe(
      'Vouch for Dave as Kin for You and Sam. Each keeps their own record, and you can revoke the vouch later.',
    );
  });
});

describe('contact detail / new contact page copy', () => {
  it('sanitises the interpolated name in every dynamic function', () => {
    const malicious = 'Eve‮Joe'; // LRO bidi override
    expect(removeRoleAriaLabel(malicious)).toBe('Remove role EveJoe');
    expect(blockConfirmLabel(malicious)).toBe('Block EveJoe');
    expect(removeContactConfirmCopy(malicious)).toBe(
      "Remove EveJoe from your contacts? Their record is tombstoned on this device.",
    );
    expect(addingToContactsCopy(malicious)).toBe("Adding to EveJoe's contacts.");
  });

  it('keeps the exact wording used on the pages', () => {
    expect(removeRoleAriaLabel('mum')).toBe('Remove role mum');
    expect(blockConfirmLabel('Dave')).toBe('Block Dave');
    expect(removeContactConfirmCopy('Dave')).toBe(
      "Remove Dave from your contacts? Their record is tombstoned on this device.",
    );
    expect(addingToContactsCopy('Sam')).toBe("Adding to Sam's contacts.");
  });
});

describe('fixed strings', () => {
  it('keeps the keyless and boundary copy honest', () => {
    expect(KEYLESS_MARKER).toBe('No key verified');
    expect(KEYLESS_EXPLAINER).toContain('need a verified key');
    expect(GUARDIAN_BLOCK_LOCK_COPY).toBe('A guardian applied this block');
    expect(BLOCK_BOUNDARY_COPY).toContain('cannot stop someone posting on Nostr');
    expect(CONTACTS_BACKUP_TOO_LARGE_COPY).toContain('too large');
    expect(CONTACTS_BACKUP_STALLED_COPY).toContain('not read the contact backup');
  });

  it('says how many grants were skipped, and singular/plural correctly (R-26)', () => {
    expect(GRANTS_SKIPPED_REMOTE_COPY(1)).toContain('1 app you connected on another device');
    expect(GRANTS_SKIPPED_REMOTE_COPY(1)).toContain('make room for it');
    expect(GRANTS_SKIPPED_REMOTE_COPY(3)).toContain('3 apps you connected on another device');
    expect(GRANTS_SKIPPED_REMOTE_COPY(3)).toContain('make room for them');
    // Never claims anything was lost — the other device still holds the grant.
    expect(GRANTS_SKIPPED_REMOTE_COPY(2).toLowerCase()).not.toContain('lost');
  });

  it('avoids the forbidden vocabulary from spec section 12', () => {
    const all = [
      KEYLESS_MARKER,
      KEYLESS_EXPLAINER,
      GUARDIAN_BLOCK_LOCK_COPY,
      BLOCK_BOUNDARY_COPY,
      CONTACTS_BACKUP_TOO_LARGE_COPY,
      CONTACTS_BACKUP_STALLED_COPY,
      GRANTS_SKIPPED_REMOTE_COPY(1),
      GRANTS_SKIPPED_REMOTE_COPY(3),
      independenceGateCopy('Sam'),
      removalChoiceCopy('Sam').deleteLine,
      removalChoiceCopy('Sam').archiveLine,
      defaultChildCeilingCopy('Sam'),
      shareConfirmCopy('Dave', ['Sam']),
      vouchConfirmCopy('Dave', 'kith', ['Sam']),
    ]
      .join(' ')
      .toLowerCase();
    for (const banned of ['guest', 'provisional', 'burner', 'organization', 'recognize', 'authorize']) {
      expect(all).not.toContain(banned);
    }
  });
});

describe('grant capability copy (R-28d, A/M1)', () => {
  it('says the app ADDS a Ken contact, never that it asks', () => {
    // The implementation applies an accepted batch the moment it validates:
    // no queue, no prompt, no owner decision. Copy that promised a question
    // made the consent false.
    const addKen = CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.propose:add-ken'].toLowerCase();
    for (const banned of ['ask', 'may accept', 'approve', 'request', 'propose']) {
      expect(addKen).not.toContain(banned);
    }
    expect(addKen).toContain('add contacts to your ken list');
    expect(addKen).toContain('no access');
  });

  it('describes only names and public keys on the default grant', () => {
    expect(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'].toLowerCase())
      .toBe('see contact names and public keys only.');
  });

  it('describes every capability the SDK knows about', () => {
    for (const cap of CAPABILITIES) {
      expect(CONTACTS_GRANT_CAPABILITY_COPY[cap].length).toBeGreaterThan(10);
    }
  });
});

describe('module source vocabulary check', () => {
  /**
   * Single-pass tokenizer over raw source. Outside of a string/template
   * literal, `//` skips to end of line and `/*` skips to the matching
   * `*\/` — both as plain tokens, never looking inside a literal for a
   * comment marker. Inside a literal (opened by `'`, `"` or `` ` ``), it
   * reads verbatim (honouring `\` escapes) until the matching unescaped
   * closer — never looking inside a comment for a quote, and never
   * stopping a literal early because it contains `//` or `/*`. Nothing
   * runs before this pass: it is the only thing that ever looks at the
   * source, so there is no earlier step that could corrupt a literal.
   *
   * Known limit, accepted: a template literal's `${ … }` interpolations are
   * NOT parsed as code. The whole span between the backticks is read as one
   * literal, expression text included, and a nested backtick inside an
   * interpolation would close the outer literal early. The effect on this
   * guard is that it over-scans (an identifier inside `${}` is checked as if
   * it were prose) and can end a template early, which at worst misses some
   * text later in the same file — it never fabricates a forbidden word that
   * is not in the source. Copy in this codebase interpolates plain
   * identifiers, so neither has bitten; a real parser here would be a lot of
   * machinery for a guard whose failure mode is a false positive a human
   * reads in half a second.
   */
  function extractLiterals(source: string): string[] {
    const literals: string[] = [];
    const n = source.length;
    let i = 0;
    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        let j = i + 1;
        let content = '';
        while (j < n && source[j] !== quote) {
          if (source[j] === '\\' && j + 1 < n) {
            content += source[j] + source[j + 1];
            j += 2;
            continue;
          }
          content += source[j];
          j++;
        }
        literals.push(content);
        i = j + 1;
        continue;
      }
      i++;
    }
    return literals;
  }

  it('extractor self-test: a string literal containing // is read whole, not truncated by a trailing comment', () => {
    const sample = `const x = 'https://example.com/guest'; // guest`;
    const literals = extractLiterals(sample);
    expect(literals).toContain('https://example.com/guest');
    expect(literals).not.toContain('guest');
  });

  it('extractor self-test: a /* look-alike inside a string is not treated as a comment', () => {
    const sample = `const y = "a /* not a comment */ b";`;
    const literals = extractLiterals(sample);
    expect(literals).toContain('a /* not a comment */ b');
  });

  it('extractor self-test: a quoted word inside a block comment is never extracted', () => {
    const sample = `/** "Guest" */\nconst z = 'ok';`;
    const literals = extractLiterals(sample);
    expect(literals).toEqual(['ok']);
  });

  /**
   * A JSX `style={{ ... }}` object holds CSS values, not copy — and CSS
   * itself mandates the American spelling for several of these words
   * (`text-align: center`, never "centre"; `justify-content: center`).
   * Scanning raw file source for the vocabulary guard would flag every
   * flexbox-centred `<div>` as if it used the banned "center", which is a
   * false positive that has nothing to do with prose. This strips the
   * *value* of every `style={{ ... }}` attribute (brace-depth tracked,
   * skipping over any quoted string inside so a literal `}` there can't
   * miscount) before the same `extractLiterals` tokenizer above runs —
   * `extractLiterals` itself is unchanged and reused verbatim.
   */
  /**
   * True when the source between the start of the line containing `pos` and
   * `pos` itself has an odd count of (unescaped) quote characters — i.e.
   * `pos` sits inside an already-open string on that line.
   *
   * P4: guards the marker check below against a `style={{` MENTION inside a
   * string (a test fixture like `'style={{ also fake }}'`). It is
   * deliberately NOT a general string tokenizer that copies an arbitrary
   * quoted span through verbatim: raw JSX text can carry an English
   * apostrophe that is not a real string open at all (`{name}'s Nostr
   * public key…`), and a scan that treats every `'` as opening a string
   * would hunt for the next quote character WHEREVER it falls — potentially
   * many lines later — swallowing every real `style={{...}}` in between
   * without stripping it. Resetting the parity count at every line start
   * confines that hazard to the one line the apostrophe is on; every real
   * `style={{ … }}` mention this codebase's fixtures use fits on one line.
   */
  function oddQuotesSinceLineStart(source: string, pos: number): boolean {
    const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
    let count = 0;
    for (let k = lineStart; k < pos; k++) {
      const c = source[k];
      if ((c === "'" || c === '"' || c === '`') && source[k - 1] !== '\\') count++;
    }
    return count % 2 === 1;
  }

  function stripStyleAttributeValues(source: string): string {
    const marker = 'style={{';
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];
      // P4: a marker mention inside a `//` or `/* */` comment is skipped by
      // reading the comment to its proper end before the marker check ever
      // runs — comments are unambiguous, unlike quoted strings (see
      // `oddQuotesSinceLineStart` above), so this is always safe.
      if (ch === '/' && next === '/') {
        let j = i;
        while (j < n && source[j] !== '\n') j++;
        out += source.slice(i, j);
        i = j;
        continue;
      }
      if (ch === '/' && next === '*') {
        let j = i + 2;
        while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
        j = Math.min(j + 2, n);
        out += source.slice(i, j);
        i = j;
        continue;
      }
      if (source.startsWith(marker, i) && !oddQuotesSinceLineStart(source, i)) {
        i += marker.length;
        let depth = 2; // the two braces already consumed
        while (i < n && depth > 0) {
          const c = source[i];
          if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            i++;
            while (i < n && source[i] !== quote) {
              i += source[i] === '\\' && i + 1 < n ? 2 : 1;
            }
            i++; // consume the closing quote
            continue;
          }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          i++;
        }
        continue; // the whole style object is dropped, not copied to `out`
      }
      out += ch;
      i++;
    }
    return out;
  }

  it('style-stripper self-test: removes a style object\'s values without touching the rest of the source', () => {
    const sample = `<div style={{ textAlign: 'center', color: '#fff' }}>Hello</div>`;
    const cleaned = stripStyleAttributeValues(sample);
    expect(cleaned).not.toContain('center');
    expect(cleaned).toContain('Hello');
  });

  it('style-stripper self-test: a quote inside the style object cannot desynchronise the brace count', () => {
    const sample = `<div style={{ content: '}' }}>after</div>after2`;
    const cleaned = stripStyleAttributeValues(sample);
    expect(cleaned).toContain('after2');
    expect(cleaned).not.toContain('content');
  });

  /**
   * P4: `style={{` can appear inside a comment (a doc example) or a string
   * literal (a test fixture) without being a real JSX attribute at all. The
   * naive textual `startsWith(marker, i)` check has no way to tell those
   * apart from real source — this self-test pins that the stripper reads
   * comments and strings to their proper end FIRST, the same way
   * `extractLiterals` does, so a mention never triggers a strip and never
   * eats the content that follows it.
   */
  it('style-stripper self-test: a comment or string merely mentioning style={{ is not treated as a real style attribute', () => {
    const sample = [
      "// example: style={{ fake: 'x' }}",
      "const msg = 'style={{ also fake }}';",
      "const z = <div style={{ color: 'red' }}>hi</div>;",
    ].join('\n');
    const cleaned = stripStyleAttributeValues(sample);
    expect(cleaned).toContain("style={{ fake: 'x' }}");
    expect(cleaned).toContain('style={{ also fake }}');
    // The one REAL style attribute is still stripped.
    expect(cleaned).not.toContain('red');
    expect(cleaned).toContain('hi');
  });

  /**
   * A CSS custom-property reference — `var(--color-primary, #7c3aed)` — is
   * the other false-positive shape, and it isn't confined to a `style={{}}`
   * attribute: `ContactTierChip.tsx`'s `TIER_COLOUR` map defines these as a
   * plain object literal. `--color-primary` isn't the American spelling of
   * "colour" in prose; it's a CSS variable name, spelled the only way CSS
   * itself spells the word. A literal that is ENTIRELY a `var(...)` call is
   * excluded from the forbidden-word check below — never a literal that
   * merely contains one, so real copy sitting next to a `var()` reference is
   * still scanned.
   */
  const CSS_VAR_ONLY = /^var\(--[\w-]+(?:,\s*[^()]*)?\)$/;

  it('CSS var() self-test: matches a bare custom-property reference with or without a fallback', () => {
    expect(CSS_VAR_ONLY.test('var(--color-primary, #7c3aed)')).toBe(true);
    expect(CSS_VAR_ONLY.test('var(--accent)')).toBe(true);
  });

  it('CSS var() self-test: does not match real copy that merely mentions var(...)', () => {
    expect(CSS_VAR_ONLY.test('Set var(--accent) in your theme first')).toBe(false);
  });

  /**
   * Every contacts-v2 page/component this glob resolves gets the same
   * forbidden-vocabulary scan as the copy module itself, so a later page
   * (Phase C tasks 9+) is bound automatically without another manual test
   * edit. `.test.tsx` files are excluded — test descriptions are not
   * shipped copy, and scanning them would just chase self-inflicted false
   * positives (e.g. this very file's own fixture strings).
   */
  function collectScannedFiles(): string[] {
    const libDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(libDir, '..');
    const pagesDir = join(srcDir, 'pages');
    const componentsDir = join(srcDir, 'components');

    const matching = (dir: string, prefix: string) =>
      readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
        .map(f => join(dir, f));

    return [
      join(libDir, 'contacts-v2-copy.ts'),
      ...matching(pagesDir, 'Contact'),
      ...matching(pagesDir, 'Family'),
      ...matching(componentsDir, 'Contact'),
    ];
  }

  it('scans string literals for forbidden words and American spellings across every contacts-v2 page and component', () => {
    const forbidden = [
      'guest',
      'provisional',
      'burner',
      'organization', // British: organisation
      'recognize', // British: recognised
      'authorize', // British: authorised
      'color', // British: colour
      'favorite', // British: favourite
      'center', // British: centre
    ];

    const files = collectScannedFiles();
    // P4: the exact scanned-file list, not a floor — a `>=4` check still
    // passes if a later page never joins the glob (e.g. a typo'd prefix, or
    // a file renamed off the `Contact`/`Family` pattern), silently dropping
    // it from the vocabulary guard. Pin every basename so that drop is a
    // failing test, not a quiet gap. New Phase C+ pages are added here
    // deliberately, not implicitly.
    expect(files.map(f => f.split('/').pop()).sort()).toEqual([
      'ContactAvatar.tsx',
      'ContactChecks.tsx',
      'ContactDetail.tsx',
      'ContactInvites.tsx',
      'ContactInviteQRCard.tsx',
      'ContactNew.tsx',
      'ContactOrigins.tsx',
      'ContactShare.tsx',
      'ContactShareFields.tsx',
      'ContactShareQR.tsx',
      'ContactTierChip.tsx',
      'ContactsCard.tsx',
      'ContactsGrantApprove.tsx',
      'ContactsGrantCode.tsx',
      'ContactsGrantList.tsx',
      'ContactsRolodex.tsx',
      'FamilyContacts.tsx',
      'FamilyList.tsx',
      'contacts-v2-copy.ts',
    ].sort());

    for (const filePath of files) {
      const source = readFileSync(filePath, 'utf8');
      const cleaned = stripStyleAttributeValues(source);
      const literals = extractLiterals(cleaned).filter(l => !CSS_VAR_ONLY.test(l));
      const allStrings = literals.join(' ').toLowerCase();

      for (const word of forbidden) {
        expect(allStrings, `Found forbidden word "${word}" in string literals of ${filePath}`).not.toContain(word);
      }
    }
  });
});
