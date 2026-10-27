import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimEvent, newKey, statusEvent } from './keep-fixtures';

const fetchMock = vi.fn();
vi.mock('./relay-service', () => ({ fetchEventsWithReach: (...a: unknown[]) => fetchMock(...a) }));

import { loadMyKeeps } from './keep-load';

const me = newKey();
const node = newKey();
beforeEach(() => fetchMock.mockReset());

describe('loadMyKeeps', () => {
  it('is an outage, not an empty list, when no relay answers the claim query', async () => {
    fetchMock.mockResolvedValueOnce({ events: [], attempted: 2, reached: 0 });
    expect(await loadMyKeeps([me.pk])).toEqual({ ok: false });
  });

  it('is an outage when claims were found but no relay answers the status query', async () => {
    fetchMock.mockResolvedValueOnce({ events: [claimEvent(me, node.pk)], attempted: 2, reached: 1 })
      .mockResolvedValueOnce({ events: [], attempted: 2, reached: 0 });
    expect(await loadMyKeeps([me.pk])).toEqual({ ok: false });
  });

  it('returns each Keep with its status and ignores a status dated in the future', async () => {
    const claim = claimEvent(me, node.pk);
    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce({ events: [claim], attempted: 2, reached: 2 })
      .mockResolvedValueOnce({ events: [statusEvent(node, claim.id, { createdAt: now + 4000 })], attempted: 2, reached: 2 });
    const r = await loadMyKeeps([me.pk]);
    expect(r.ok && r.keeps).toHaveLength(1);
    expect(r.ok && r.keeps[0].status).toBeNull();
  });

  it('asks nothing when there are no valid keys', async () => {
    expect(await loadMyKeeps(['nope'])).toMatchObject({ ok: true, keeps: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
