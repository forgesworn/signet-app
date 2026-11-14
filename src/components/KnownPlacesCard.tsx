import { useEffect, useMemo, useRef, useState } from 'react';
import type { KnownPlace } from '../types/known-places';
import { badgesFor, DORMANT_SECONDS } from '../lib/known-place-badges';
import { placeLabel, sortPlaces, hostnameOf } from '../lib/known-place-label';
import {
  HeartwoodRow, KnownPlaceRow, type KnownPlaceActions, type KnownPlaceCtx, type KnownPlaceIdentityType,
} from './KnownPlaceRow';

export type { KnownPlaceActions, KnownPlaceCtx, KnownPlaceIdentityType } from './KnownPlaceRow';

export interface HeartwoodAppEntry {
  fingerprint: string;
  label: string;
  boundIdentity: string;
  policySummary: string;
}

export interface KnownPlacesCardProps {
  identityName: string;
  identityType: KnownPlaceIdentityType;
  places: KnownPlace[];
  locked: boolean;
  onUnlock: () => void;
  /** A place id to expand on arrival (set by a chip tap on the identity card). */
  focusId: string | null;
  onFocusConsumed: () => void;
  ctxFor: (place: KnownPlace) => KnownPlaceCtx;
  /** Apps paired straight to the Heartwood, or null when no operator key can list them. */
  heartwoodClients: HeartwoodAppEntry[] | null;
  /** A paired-child install has no Heartwood management: the group, and the line about Sapwood, are not rendered. */
  hideHeartwood?: boolean;
  /** False when the device is known not to support revoking an app. Default true (unknown counts as available). */
  canRevokeOnHeartwood?: boolean;
  actions: KnownPlaceActions;
}

const SEARCH_THRESHOLD = 12;

interface Entry { place: KnownPlace; ctx: KnownPlaceCtx; last: number }

/**
 * The list column: every place this identity is known, grouped, each row
 * expanding in place into facts then actions. A record the person can act on;
 * nothing here is a trust input.
 */
export function KnownPlacesCard({
  identityName, identityType, places, locked, onUnlock, focusId, onFocusConsumed, ctxFor, heartwoodClients, hideHeartwood, canRevokeOnHeartwood = true, actions,
}: KnownPlacesCardProps) {
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const entries = useMemo<Entry[]>(() => sortPlaces(places).map(place => {
    const ctx = ctxFor(place);
    return { place, ctx, last: Math.max(place.lastAt, ctx.lastSeenAt ?? 0) };
  }), [places, ctxFor]);

  const total = entries.length + (heartwoodClients?.length ?? 0);
  const searching = total > SEARCH_THRESHOLD;
  const needle = searching ? query.trim().toLowerCase() : '';

  const matches = (e: Entry) => !needle
    || [placeLabel(e.place), e.place.name, e.place.alias ?? '', e.place.origin ?? '', hostnameOf(e.place.origin)]
      .some(text => text.toLowerCase().includes(needle));

  const visible = entries.filter(matches);
  const pinned = visible.filter(e => e.place.pinned);
  const rest = visible.filter(e => !e.place.pinned);
  const recent = rest.filter(e => now - e.last <= DORMANT_SECONDS);
  const dormant = rest.filter(e => now - e.last > DORMANT_SECONDS);
  const heartwood = (heartwoodClients ?? []).filter(c => !needle || `${c.label} ${c.boundIdentity}`.toLowerCase().includes(needle));

  // A chip tap hands over an id: open that row, bring it into view, then say so.
  useEffect(() => {
    if (locked || !focusId) return;
    setQuery('');
    setExpandedId(focusId);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list ? Array.from(list.querySelectorAll<HTMLElement>('[data-kp-row]')).find(el => el.dataset.kpRow === focusId) : undefined;
      if (list && row) list.scrollTop = Math.max(0, row.offsetTop - 8);
    });
    // The frame is left to run even when the parent clears the focus at once.
    onFocusConsumed();
    // onFocusConsumed is the parent's to keep stable; the id is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, locked]);

  const toggle = (id: string) => setExpandedId(cur => (cur === id ? null : id));

  const renderGroup = (title: string, group: Entry[]) => group.length === 0 ? null : (
    <section className="kp-group" aria-label={title} key={title}>
      <h3 className="kp-group-title">{title}</h3>
      <ul className="kp-list">
        {group.map(e => (
          <KnownPlaceRow
            key={e.place.id}
            place={e.place}
            ctx={e.ctx}
            identityName={identityName}
            identityType={identityType}
            last={e.last}
            now={now}
            badges={badgesFor(e.place, { askToSign: e.ctx.askToSign, nip55Grant: e.ctx.nip55Grant, loading: e.ctx.loading, signedBy: e.ctx.signedBy, now })}
            expanded={expandedId === e.place.id}
            onToggle={() => toggle(e.place.id)}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );

  return (
    <section className="known-places-card" aria-label={`Where ${identityName || 'this identity'} is known`}>
      <header className="kp-header">
        <h2>Where you’re known</h2>
        <p className="kp-header-sub" title={identityName}>{identityName || 'This identity'}</p>
      </header>

      <div className="kp-body" ref={listRef}>
        {locked ? (
          <button type="button" className="card-launcher-chip card-launcher-chip--locked kp-unlock" onClick={onUnlock}
            aria-label="Unlock to see where this identity is known">
            Unlock to see where this identity is known
          </button>
        ) : (
          <>
            {searching && (
              <input
                type="search"
                className="kp-input kp-search"
                aria-label="Search places"
                placeholder="Search places"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            )}
            {entries.length === 0 && (
              <p className="kp-empty">Not known anywhere yet. Sites and apps you sign in to or pair will appear here.</p>
            )}
            {needle && visible.length === 0 && heartwood.length === 0 && <p className="kp-empty">Nothing matches.</p>}
            {renderGroup('Pinned', pinned)}
            {renderGroup('Recent', recent)}
            {renderGroup('Not used in 3 months', dormant)}
            {hideHeartwood ? null : heartwoodClients !== null ? (
              heartwoodClients.length === 0 && !needle ? (
                <p className="kp-note">No apps are paired straight to your Heartwood.</p>
              ) : heartwood.length > 0 && (
                <section className="kp-group" aria-label="On your Heartwood">
                  <h3 className="kp-group-title">On your Heartwood</h3>
                  <ul className="kp-list">
                    {heartwood.map(c => (
                      <HeartwoodRow
                        key={c.fingerprint}
                        {...c}
                        expanded={expandedId === `hw:${c.fingerprint}`}
                        onToggle={() => toggle(`hw:${c.fingerprint}`)}
                        onRevoke={actions.revokeOnHeartwood}
                        canRevoke={canRevokeOnHeartwood}
                      />
                    ))}
                  </ul>
                </section>
              )
            ) : (
              <p className="kp-note">Apps paired straight to your Heartwood are managed in Sapwood.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** A dependant's card: the places live with the dependant's own activity, not here. */
export function KnownPlacesDependantCard({ name }: { name: string }) {
  return (
    <section className="known-places-card" aria-label={`Where ${name || 'this dependant'} is known`}>
      <header className="kp-header">
        <h2>Where you’re known</h2>
        <p className="kp-header-sub" title={name}>{name || 'This dependant'}</p>
      </header>
      <div className="kp-body">
        <p className="kp-note">Where {name || 'this dependant'} is known shows on their Activity page.</p>
      </div>
    </section>
  );
}
