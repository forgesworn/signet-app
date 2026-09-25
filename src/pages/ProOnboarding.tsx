/**
 * ProOnboarding — multi-step Pro-surface onboarding.
 *
 * Steps:
 *  1. pick-profession — choose head teacher / lead GP / senior solicitor
 *  2. pick-jurisdiction — choose regulatory jurisdiction (school: all UK; GP: England only; SRA: E&W)
 *  3. identifier — enter registry identifier (URN / CQC Provider ID / SRA Firm Number)
 *  4. confirm-domain — confirm / correct canonical website domain
 *  5. generate-json — signet.json + HTML snippet for webmaster
 *  6. check-json — fetch + validate live signet.json
 *  7. success — optionally list in directory → publish role-anchor event
 *
 * Spec: the internal Pro-surface architecture design doc, §6
 */

import { useState, type ReactNode } from 'react';
import type { ProfessionKind, Jurisdiction, RegulatedEntityRecord } from '../lib/professional/types';
import { proResolver } from '../lib/professional/resolver';
import { generateSignetJson, fetchAndValidateSignetJson, normaliseHost } from '../lib/professional/signet-json';
import { buildDirectoryAddEvent } from '../lib/professional/role-anchor';
import type { AnchorContext } from '../lib/professional/role-anchor';
import type { SigningBackend } from '../lib/signing-backend';
import type { UseProRoleAnchorResult } from '../hooks/useProRoleAnchor';
import { publishEvent } from '../lib/relay-service';
import { saveProDirectoryPreference } from '../lib/db';
import { nip19 } from 'nostr-tools';

type OnboardingStep =
  | 'pick-profession'
  | 'pick-jurisdiction'
  | 'pick-authority-model'   // §3.6.2 Q1 — sole-lead / co-leads / lead-with-delegates
  | 'add-co-leads'           // only reached when model === 'co-leads'
  | 'identifier'
  | 'confirm-domain'
  | 'generate-json'
  | 'check-json'
  | 'success';

type AuthorityModel = 'sole-lead' | 'co-leads' | 'lead-with-delegates';

const MAX_CO_LEADS = 4; // 5 total including the device lead

interface Props {
  /**
   * The Professional Persona hex pubkey — NOT the Natural Person pubkey.
   * Spec §4.5.6: "Any event in the Pro-surface chain that carries a Natural
   * Person pubkey MUST be treated as invalid by verifiers."
   */
  leadPubkeyHex: string;
  backend: SigningBackend;
  proAnchorHook: Pick<UseProRoleAnchorResult, 'publish'>;
  onComplete: () => void;
  onBack: () => void;
}

interface ProfessionConfig {
  kind: ProfessionKind;
  label: string;
  role: string;
  identifierLabel: string;
  identifierHint: string;
  identifierPlaceholder: string;
  signetJsonKind: string;
  lookupUrl: string;
  lookupLabel: string;
}

function professionKindLabel(kind: ProfessionKind): string {
  const labels: Record<ProfessionKind, string> = {
    'school': 'school',
    'gp-practice': 'GP practice',
    'solicitor-firm': 'solicitor firm',
    'pharmacy': 'pharmacy',
    'dental-practice': 'dental practice',
    'accountant-firm': 'accountant firm',
  };
  return labels[kind] ?? kind;
}

const PROFESSION_CONFIGS: ProfessionConfig[] = [
  {
    kind: 'school',
    label: 'Head teacher',
    role: 'Head',
    identifierLabel: 'School URN',
    identifierHint: "Your school's Unique Reference Number from the DfE register.",
    identifierPlaceholder: '100000',
    signetJsonKind: 'school',
    lookupUrl: 'https://get-information-schools.service.gov.uk/Search',
    lookupLabel: "Find your school's URN on GIAS",
  },
  {
    kind: 'gp-practice',
    label: 'Lead GP / senior partner',
    role: 'Lead GP',
    identifierLabel: 'CQC Provider ID',
    identifierHint: "Your practice's CQC Provider ID from the CQC register (e.g. RXL).",
    identifierPlaceholder: 'RXL',
    signetJsonKind: 'gp-practice',
    lookupUrl: 'https://www.cqc.org.uk/search/services',
    lookupLabel: "Find your practice's Provider ID on CQC",
  },
  {
    kind: 'solicitor-firm',
    label: 'Senior solicitor / managing partner',
    role: 'Senior Partner',
    identifierLabel: 'SRA Firm Number',
    identifierHint: "Your firm's SRA firm number from the Solicitors Register.",
    identifierPlaceholder: '123456',
    signetJsonKind: 'solicitor-firm',
    lookupUrl: 'https://www.sra.org.uk/consumers/register/',
    lookupLabel: "Find your firm number on the SRA register",
  },
];

interface JurisdictionOption { value: Jurisdiction; label: string; }

function jurisdictionsForProfession(kind: ProfessionKind): JurisdictionOption[] {
  switch (kind) {
    case 'school':
      return [
        { value: 'england', label: 'England' },
        { value: 'wales', label: 'Wales' },
        { value: 'scotland-state', label: 'Scotland (state school)' },
        { value: 'scotland-private', label: 'Scotland (independent school)' },
        { value: 'northern-ireland', label: 'Northern Ireland' },
      ];
    case 'gp-practice':
      return [{ value: 'england', label: 'England' }];
    case 'solicitor-firm':
      return [{ value: 'england-wales', label: 'England and Wales' }];
    default:
      return [{ value: 'england', label: 'England' }];
  }
}

export function ProOnboarding({ leadPubkeyHex, backend, proAnchorHook, onComplete }: Props) {
  const [step, setStep] = useState<OnboardingStep>('pick-profession');
  const [selectedProfession, setSelectedProfession] = useState<ProfessionConfig | null>(null);
  // jurisdiction is set by the pick-jurisdiction step. Stored for resolver disambiguation
  // when a future dispatcher version accepts it explicitly (Task 10 §12 Q10 comment).
  // resolvedRecord.jurisdiction is authoritative after resolution.
  const [selectedJurisdiction, setSelectedJurisdiction] = useState<Jurisdiction>('england');
  const [identifier, setIdentifier] = useState('');
  const [resolvedRecord, setResolvedRecord] = useState<RegulatedEntityRecord | null>(null);
  const [confirmedDomain, setConfirmedDomain] = useState('');
  const [signetJson, setSignetJson] = useState('');
  const [htmlSnippet, setHtmlSnippet] = useState('');
  const [listedInDirectory, setListedInDirectory] = useState(true);
  const [directoryPublishing, setDirectoryPublishing] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Authority model (§3.6.2)
  const [authorityModel, setAuthorityModel] = useState<AuthorityModel>('sole-lead');
  const [coLeadNpubs, setCoLeadNpubs] = useState<string[]>([]);
  const [coLeadInput, setCoLeadInput] = useState('');
  const [coLeadError, setCoLeadError] = useState<string | null>(null);

  const leadNpub = nip19.npubEncode(leadPubkeyHex);

  /**
   * Returns the per-profession suggested authority model (spec §3.6.4).
   * The suggestion pre-fills the picker but is never enforced.
   */
  function suggestedAuthorityModel(kind: ProfessionKind): AuthorityModel {
    switch (kind) {
      case 'school': return 'lead-with-delegates';
      case 'gp-practice': return 'co-leads';
      case 'solicitor-firm': return 'co-leads';
      default: return 'sole-lead';
    }
  }

  // ── Shared handlers (used by both mobile and desktop branches) ──────────────

  function handleProfessionPick(cfg: ProfessionConfig) {
    setSelectedProfession(cfg);
    setAuthorityModel(suggestedAuthorityModel(cfg.kind));
    const jurisdictions = jurisdictionsForProfession(cfg.kind);
    if (jurisdictions.length === 1) {
      // Skip jurisdiction picker when there's only one option
      setSelectedJurisdiction(jurisdictions[0].value);
      setStep('pick-authority-model');
    } else {
      setStep('pick-jurisdiction');
    }
  }

  function handleAuthorityContinue() {
    if (authorityModel === 'co-leads') {
      setStep('add-co-leads');
    } else {
      setStep('identifier');
    }
  }

  function makeAddCoLead() {
    return function addCoLead() {
      const trimmed = coLeadInput.trim();
      if (!trimmed.startsWith('npub1') || trimmed.length < 60) {
        setCoLeadError('Please enter a valid npub (starts with npub1, at least 60 characters).');
        return;
      }
      if (coLeadNpubs.includes(trimmed)) {
        setCoLeadError('That npub is already in the list.');
        return;
      }
      if (coLeadNpubs.length >= MAX_CO_LEADS) {
        setCoLeadError(`You can add at most ${MAX_CO_LEADS} co-leads (5 total including yourself).`);
        return;
      }
      setCoLeadNpubs(prev => [...prev, trimmed]);
      setCoLeadInput('');
      setCoLeadError(null);
    };
  }

  async function handleResolveIdentifier() {
    if (!selectedProfession) return;
    setError(null);
    setIsWorking(true);
    try {
      const record = await proResolver.resolve(selectedProfession.kind, identifier.trim());
      if (!record) {
        setError(`No record found for ${selectedProfession.identifierLabel} "${identifier.trim()}". Check the identifier and try again.`);
        setIsWorking(false);
        return;
      }
      if (record.status !== 'Active' && record.status !== 'Open') {
        setError(`This organisation's status is "${record.status}" in the registry. Only active organisations can set up a Professional role.`);
        setIsWorking(false);
        return;
      }
      setResolvedRecord(record);
      const domain = record.website ?? record.inferredCandidateWebsite ?? '';
      setConfirmedDomain(domain);
      setStep('confirm-domain');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registry lookup failed. Please try again.');
    } finally {
      setIsWorking(false);
    }
  }

  function handleConfirmDomain() {
    if (!resolvedRecord) return;
    const domain = normaliseHost(confirmedDomain.trim());
    if (!domain) {
      setError('Please enter your organisation\'s website domain.');
      return;
    }
    setConfirmedDomain(domain);

    const now = new Date().toISOString();
    // leadNpub is derived from leadPubkeyHex (the Pro persona pubkey, not NP).
    // Spec §6.5 + §4.5.6: headPubkey in signet.json must be the Pro persona npub.
    // When co-leads were added in the add-co-leads step, emit headPubkeys (array).
    const json = generateSignetJson({
      professionKind: resolvedRecord.professionKind,
      entityName: resolvedRecord.name,
      identifier: resolvedRecord.identifier,
      identifierKind: resolvedRecord.identifierKind,
      leadPubkeyNpubs: [leadNpub, ...coLeadNpubs],
      canonicalDomain: domain,
      relays: ['wss://relay.forgesworn.dev'],
      publishedAt: now,
    });

    const snippet = `<link rel="signet-pubkey" content="${leadNpub}" />`;
    setSignetJson(json);
    setHtmlSnippet(snippet);
    setError(null);
    setStep('generate-json');
  }

  async function handleCheckJson() {
    if (!resolvedRecord) return;
    setError(null);
    setIsWorking(true);
    try {
      // leadNpub is derived from leadPubkeyHex (the Pro persona pubkey).
      // Spec §4.5.6 + §6.7: headPubkey in signet.json must match the Pro persona,
      // NOT the Natural Person pubkey. Any NP pubkey here would be treated as
      // invalid by verifiers.
      await fetchAndValidateSignetJson(
        `https://${confirmedDomain}`,
        resolvedRecord.identifier,
        leadNpub
      );
      setStep('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed. Please try again.');
    } finally {
      setIsWorking(false);
    }
  }

  async function handleFinishSuccess() {
    if (!resolvedRecord) return;
    setDirectoryPublishing(true);
    setError(null);
    try {
      const ctx: AnchorContext = {
        registry: resolvedRecord.registry,
        identifier: resolvedRecord.identifier,
        professionKind: resolvedRecord.professionKind,
        entityName: resolvedRecord.name,
        canonicalDomain: confirmedDomain,
        jurisdiction: selectedJurisdiction,
        leadPubkey: leadPubkeyHex,
      };
      await proAnchorHook.publish(backend, ctx, { listedInDirectory });
      await saveProDirectoryPreference(
        { kind: resolvedRecord.identifierKind, value: resolvedRecord.identifier },
        listedInDirectory,
      );
      if (listedInDirectory) {
        const directoryTemplate = buildDirectoryAddEvent(ctx);
        const unsigned = { ...directoryTemplate, pubkey: backend.activePublicKeyHex };
        const signed = await backend.signEvent(unsigned);
        await publishEvent(signed);
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish. Please try again.');
    } finally {
      setDirectoryPublishing(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return renderMobile();

  function renderMobile(): ReactNode {

  // ── Step 1: Profession picker ────────────────────────────────────────────────

  if (step === 'pick-profession') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          What is your professional role?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {PROFESSION_CONFIGS.map(cfg => (
            <button
              key={cfg.kind}
              className="btn btn-secondary"
              style={{ textAlign: 'left', justifyContent: 'flex-start' }}
              onClick={() => handleProfessionPick(cfg)}
            >
              <span style={{ display: 'block', width: '100%' }}>
                <span style={{ display: 'block', fontWeight: 600 }}>{cfg.label}</span>
                <span style={{ display: 'block', fontSize: '0.8rem', opacity: 0.8, marginTop: 2 }}>
                  {cfg.identifierLabel}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 2: Jurisdiction picker ──────────────────────────────────────────────

  if (step === 'pick-jurisdiction' && selectedProfession) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={() => setStep('pick-profession')} style={{ marginBottom: 16 }}>← Back</button>
        <h2 style={{ marginBottom: 8 }}>Which part of the UK?</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          Some registers differ by jurisdiction. Choose where your organisation is regulated.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {jurisdictionsForProfession(selectedProfession.kind).map(j => (
            <button
              key={j.value}
              className="btn btn-secondary"
              style={{ textAlign: 'left' }}
              onClick={() => {
                setSelectedJurisdiction(j.value);
                setStep('pick-authority-model');
              }}
            >
              {j.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 3a: Authority model picker ─────────────────────────────────────────

  if (step === 'pick-authority-model' && selectedProfession) {
    const kind = selectedProfession.kind;
    const suggested = suggestedAuthorityModel(kind);
    const kindLabel = professionKindLabel(kind);

    function authorityLabel(model: AuthorityModel): string {
      switch (model) {
        case 'sole-lead':
          return suggested === 'sole-lead'
            ? `Just me (recommended for small ${kindLabel}s with a hands-on lead)`
            : 'Just me';
        case 'co-leads':
          return suggested === 'co-leads'
            ? `Shared with others (recommended for ${kindLabel}s)`
            : 'Shared with others';
        case 'lead-with-delegates':
          return suggested === 'lead-with-delegates'
            ? `With a deputy or manager (recommended for larger ${kindLabel}s)`
            : 'With a deputy or manager';
      }
    }

    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={() => {
            const jurisdictions = jurisdictionsForProfession(selectedProfession.kind);
            setStep(jurisdictions.length === 1 ? 'pick-profession' : 'pick-jurisdiction');
          }}
          style={{ marginBottom: 16 }}
        >
          ← Back
        </button>
        <h2 style={{ marginBottom: 8 }}>How is your organisation led?</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 20 }}>
          All three patterns work the same for verifiers — pick what matches how your firm runs. You can always change later.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          {(['sole-lead', 'co-leads', 'lead-with-delegates'] as AuthorityModel[]).map(model => (
            <label
              key={model}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '14px 16px',
                borderRadius: 10,
                border: authorityModel === model
                  ? '2px solid var(--accent)'
                  : '1px solid var(--border)',
                background: authorityModel === model
                  ? 'var(--surface-secondary)'
                  : 'var(--surface)',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="authority-model"
                value={model}
                checked={authorityModel === model}
                onChange={() => setAuthorityModel(model)}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>
                  {authorityLabel(model)}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {model === 'sole-lead' && 'Best for sole practitioners + small schools with a single head.'}
                  {model === 'co-leads' && 'Best for GP partnerships + solicitor firms with multiple partners.'}
                  {model === 'lead-with-delegates' && 'Best for larger orgs where a deputy handles day-to-day staff management.'}
                </div>
              </div>
            </label>
          ))}
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: 20 }}>
          You can change this later.
        </p>

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleAuthorityContinue}
        >
          Continue
        </button>
      </div>
    );
  }

  // ── Step 3b: Add co-leads ────────────────────────────────────────────────────

  if (step === 'add-co-leads' && selectedProfession) {
    const addCoLead = makeAddCoLead();

    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={() => setStep('pick-authority-model')}
          style={{ marginBottom: 16 }}
        >
          ← Back
        </button>
        <h2 style={{ marginBottom: 8 }}>Add co-leads</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 20 }}>
          Paste the npub of each co-lead. Each person must have a Signet identity.
        </p>

        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '0.9rem' }}>
          Co-lead npub
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            value={coLeadInput}
            onChange={e => { setCoLeadInput(e.target.value); setCoLeadError(null); }}
            placeholder="npub1…"
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              fontSize: '0.9rem',
            }}
            autoComplete="off"
            autoCapitalize="none"
            onKeyDown={e => { if (e.key === 'Enter') addCoLead(); }}
          />
          <button
            className="btn btn-secondary"
            onClick={addCoLead}
            disabled={coLeadNpubs.length >= MAX_CO_LEADS}
          >
            Add
          </button>
        </div>

        {coLeadError && (
          <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{coLeadError}</p>
        )}

        {coLeadNpubs.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600 }}>
              Co-leads added ({coLeadNpubs.length}/{MAX_CO_LEADS}):
            </p>
            {coLeadNpubs.map((npub, idx) => (
              <div
                key={npub}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  marginBottom: 4,
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <span style={{ wordBreak: 'break-all', flex: 1, marginRight: 8 }}>
                  {npub.slice(0, 20)}…{npub.slice(-8)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: '0.75rem', padding: '2px 8px', flexShrink: 0 }}
                  onClick={() => setCoLeadNpubs(prev => prev.filter((_, i) => i !== idx))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {coLeadNpubs.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 20 }}>
            No co-leads added yet. You can continue without adding any — just you will be the sole lead.
          </p>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={() => setStep('identifier')}
        >
          Continue
        </button>
      </div>
    );
  }

  // ── Step 3: Identifier ───────────────────────────────────────────────────────

  if (step === 'identifier' && selectedProfession) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={() => {
          setStep('pick-authority-model');
        }} style={{ marginBottom: 16 }}>← Back</button>
        <h2 style={{ marginBottom: 8 }}>Enter your identifier</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          {selectedProfession.label}
        </p>

        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '0.9rem' }}>
          {selectedProfession.identifierLabel}
        </label>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: 4 }}>
          {selectedProfession.identifierHint}
        </p>
        <p style={{ marginBottom: 8 }}>
          <a
            href={selectedProfession.lookupUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)', fontSize: '0.82rem', textDecoration: 'underline' }}
          >
            {selectedProfession.lookupLabel} ↗
          </a>
        </p>
        <input
          type="text"
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          placeholder={selectedProfession.identifierPlaceholder}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.95rem', marginBottom: 16, boxSizing: 'border-box' }}
          autoComplete="off"
        />

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 16 }}>{error}</p>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleResolveIdentifier}
          disabled={isWorking || identifier.trim().length === 0}
        >
          {isWorking ? 'Looking up…' : 'Look up in registry'}
        </button>
      </div>
    );
  }

  // ── Step 4: Confirm domain ────────────────────────────────────────────────────

  if (step === 'confirm-domain' && resolvedRecord) {
    const isInferred = resolvedRecord.website === null && resolvedRecord.inferredCandidateWebsite !== null;

    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={() => setStep('identifier')} style={{ marginBottom: 16 }}>← Back</button>
        <h2 style={{ marginBottom: 8 }}>Confirm your website</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Found: <strong>{resolvedRecord.name}</strong> ({resolvedRecord.locality}, {resolvedRecord.postcode})
        </p>

        {isInferred ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
            The registry has no website for this organisation. We've suggested a domain based on the email pattern — please confirm or correct it.
          </p>
        ) : (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
            This is the website the registry has on file. Confirm it matches your actual website.
          </p>
        )}

        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '0.9rem' }}>
          Website domain
        </label>
        <input
          type="text"
          value={confirmedDomain}
          onChange={e => setConfirmedDomain(e.target.value)}
          placeholder="springfield-school.example"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.95rem', marginBottom: 16, boxSizing: 'border-box' }}
          autoComplete="url"
          autoCapitalize="none"
        />

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{error}</p>
        )}

        <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleConfirmDomain}>
          Confirm and generate signet.json
        </button>
      </div>
    );
  }

  // ── Step 5: Generate JSON + HTML snippet ─────────────────────────────────────

  if (step === 'generate-json') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={() => setStep('confirm-domain')} style={{ marginBottom: 16 }}>← Back</button>
        <h2 style={{ marginBottom: 8 }}>Share with your webmaster</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 16 }}>
          Send your webmaster two things:
        </p>

        <p style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 6 }}>1. The signet.json file</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 8 }}>
          Ask them to upload it to <code>/.well-known/signet.json</code> on your website.
        </p>
        <pre style={{
          background: 'var(--bg-code)',
          padding: 12,
          borderRadius: 8,
          fontSize: '0.75rem',
          overflowX: 'auto',
          marginBottom: 16,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {signetJson}
        </pre>
        <button
          className="btn btn-secondary"
          style={{ marginBottom: 20 }}
          onClick={() => navigator.clipboard?.writeText(signetJson)}
        >
          Copy signet.json
        </button>

        <p style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 6 }}>2. The HTML snippet</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 8 }}>
          Ask them to add this to the <code>&lt;head&gt;</code> of your canonical page.
        </p>
        <pre style={{
          background: 'var(--bg-code)',
          padding: 12,
          borderRadius: 8,
          fontSize: '0.75rem',
          overflowX: 'auto',
          marginBottom: 16,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {htmlSnippet}
        </pre>
        <button
          className="btn btn-secondary"
          style={{ marginBottom: 24 }}
          onClick={() => navigator.clipboard?.writeText(htmlSnippet)}
        >
          Copy HTML snippet
        </button>

        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setStep('check-json')}>
          My webmaster has uploaded it — Check my JSON
        </button>
      </div>
    );
  }

  // ── Step 6: Check my JSON ─────────────────────────────────────────────────────

  if (step === 'check-json' && resolvedRecord) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={() => setStep('generate-json')} style={{ marginBottom: 16 }}>← Back</button>
        <h2 style={{ marginBottom: 8 }}>Check my JSON</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 24 }}>
          Tap the button below to check that your signet.json is live at{' '}
          <strong>https://{confirmedDomain}/.well-known/signet.json</strong>.
          If your webmaster hasn't uploaded it yet, just come back when they have.
        </p>

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 16 }}>{error}</p>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleCheckJson}
          disabled={isWorking}
        >
          {isWorking ? 'Checking…' : 'Check my JSON'}
        </button>
      </div>
    );
  }

  // ── Step 7: Success ─────────────────────────────────────────────────────────

  if (step === 'success' && resolvedRecord) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: '3rem', marginBottom: 8 }} aria-hidden="true">✓</div>
          <h2 style={{ marginBottom: 8 }}>Your Professional role is active</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 24 }}>
            <strong>{resolvedRecord.name}</strong> is verified against the{' '}
            {resolvedRecord.registry} registry.
          </p>
        </div>

        <div
          role="group"
          aria-labelledby="directory-toggle-label"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            background: 'var(--surface-secondary)',
            borderRadius: 10,
            padding: '14px 16px',
            marginBottom: 20,
            textAlign: 'left',
          }}
        >
          <input
            id="directory-toggle"
            type="checkbox"
            checked={listedInDirectory}
            onChange={e => setListedInDirectory(e.target.checked)}
            style={{ marginTop: 3, flexShrink: 0 }}
            aria-describedby="directory-toggle-description"
          />
          <div>
            <label
              id="directory-toggle-label"
              htmlFor="directory-toggle"
              style={{ fontWeight: 600, cursor: 'pointer' }}
            >
              List my {professionKindLabel(resolvedRecord.professionKind)} in the Signet directory
            </label>
            <p
              id="directory-toggle-description"
              style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}
            >
              Your {professionKindLabel(resolvedRecord.professionKind)} will appear in the public
              Signet directory. Your{' '}
              <code style={{ fontSize: '0.75rem' }}>signet.json</code> is already public — this just
              makes it discoverable. Unchecking keeps full functionality but removes public listing.
            </p>
          </div>
        </div>

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 16 }}>{error}</p>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          onClick={handleFinishSuccess}
          disabled={directoryPublishing || isWorking}
        >
          {directoryPublishing ? 'Publishing…' : 'Continue to dashboard'}
        </button>
      </div>
    );
  }

  return null;
  }
}
