/** Hands-only S2 bench, served by Vite at /tools/handshake-s2.html.
 * Reuses the production sigil component. Nothing is added to the app build. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { JigsawSigil } from '../src/components/JigsawSigil';
import '../src/styles/global.css';
const query = new URLSearchParams(location.hash.slice(1));
const seed = /^[0-9a-f]{64}$/.test(query.get('seed') ?? '') ? query.get('seed')! : bytesToHex(randomBytes(32));
const half = query.get('half') === 'right' ? 'right' : 'left';
const trial = Math.max(1, Math.min(25, Number(query.get('trial')) || 1));
const digest = (label: string) => bytesToHex(sha256(new TextEncoder().encode(`signet:handshake:s2:v1:${seed}:${label}`)));
const trials = Array.from({ length: 25 }, (_, i) => ({ broken: i < 20, key: digest(`order:${i}`), i }))
  .sort((a, b) => a.key.localeCompare(b.key));
const mark = digest(`mark:${trial}:left`);
const shown = half === 'right' && trials[trial - 1].broken ? digest(`mark:${trial}:right`) : mark;
const url = (side: string, index: number) => `${location.pathname}#${new URLSearchParams({ seed, half: side, trial: String(index) })}`;
history.replaceState(null, '', url(half, trial));
window.addEventListener('hashchange', () => location.reload());
createRoot(document.getElementById('s2-root')!).render(<main className="page">
  <h2>Jigsaw readability · {trial}/25</h2>
  <p>{half === 'left' ? 'Left phone' : 'Right phone'}</p>
  <div className="handshake-screen"><JigsawSigil digest={shown} half={half} /></div>
  <p>Put the phones edge to edge. Whole or broken?</p>
  <p><a href={url(half === 'left' ? 'right' : 'left', trial)} onClick={event => {
    event.preventDefault(); void navigator.clipboard.writeText(location.origin + url(half === 'left' ? 'right' : 'left', trial));
  }}>Copy partner link</a></p>
  {trial > 1 && <a href={url(half, trial - 1)}>Previous</a>}{' '}
  {trial < 25 && <a href={url(half, trial + 1)}>Next</a>}
  {trial === 25 && <details><summary>Answer key — after recording all responses</summary>
    <pre>{trials.map((t, i) => `${i + 1}: ${t.broken ? 'broken' : 'whole'}`).join('\n')}</pre>
  </details>}
</main>);
