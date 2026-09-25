import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

/**
 * Testing Library's async utilities (`waitFor`, `findBy*`) default to a 1000 ms
 * budget that is INDEPENDENT of Vitest's per-test timeout — passing
 * `it(..., 20_000)` raises the latter and does nothing for the former.
 *
 * Identity records are encrypted at rest with 600k-iteration PBKDF2, which
 * costs ~300 ms per save or load on this machine and more on a loaded CI box.
 * A hook test that seeds a record and then waits for `loading === false` spends
 * most of the default budget on real, intended crypto, so it passed or failed
 * on machine load rather than on behaviour: `useIdentity.test.ts` failed
 * roughly half its runs (2026-09-12) with no bug behind it.
 *
 * Raised, not removed — a genuinely stuck wait still fails, inside the
 * `testTimeout` in vitest.config.ts, with Testing Library's own message rather
 * than Vitest's less useful one. Do NOT fix a slow assertion by lowering the
 * iteration count: that would test something the app does not do.
 */
configure({ asyncUtilTimeout: 5_000 });
