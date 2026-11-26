import { describe, it, expect } from 'vitest';
import { createSlotSequencer, saveUnlessSuperseded } from './slot-sequencer';

describe('createSlotSequencer: who outranks an older send', () => {
  it('a newer send outranks while uploading, once uploaded and once saved; not once it failed', () => {
    const seq = createSlotSequencer();
    const a = seq.bump('s');
    const b = seq.bump('s');
    expect(seq.current('s')).toBe(b);
    expect(seq.superseded('s', a)).toBe(true);
    expect(seq.newerUploading('s', a)).toBe(true);
    seq.settle('s', b, 'failed');
    expect(seq.superseded('s', a)).toBe(false);
    expect(seq.newerUploading('s', a)).toBe(false);
    const c = seq.bump('s');
    seq.settle('s', c, 'uploaded');
    expect(seq.superseded('s', a)).toBe(true);
    seq.finish('s', c, true);
    expect(seq.superseded('s', a)).toBe(true);
    // A newer send never outranks itself, and an older one never outranks a newer.
    expect(seq.superseded('s', c)).toBe(false);
  });

  it('a clear outranks every older send outright, and slots are independent', () => {
    const seq = createSlotSequencer();
    const a = seq.bump('s');
    seq.bump('s', 'clear');
    expect(seq.superseded('s', a)).toBe(true);
    expect(seq.newerUploading('s', a)).toBe(false);
    const x = seq.bump('t');
    expect(seq.superseded('t', x)).toBe(false);
  });

  it('saveUnlessSuperseded waits for a newer upload outside the queue, so the newer one can still queue', async () => {
    const seq = createSlotSequencer();
    const a = seq.bump('s');
    const b = seq.bump('s');
    const order: string[] = [];
    const aDone = saveUnlessSuperseded(seq, 's', a, { save: async () => { order.push('a-save'); return 'a'; }, superseded: () => { order.push('a-discard'); return 'x'; } });
    // Something else holds the queue meanwhile: B's own save can still run after B's upload settles.
    const bSave = seq.serial('s', async () => { order.push('other'); });
    await bSave;
    seq.settle('s', b, 'failed');
    seq.finish('s', b, false);
    expect(await aDone).toBe('a');
    expect(order).toEqual(['other', 'a-save']);
  });
});
