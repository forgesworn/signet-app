// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEEP_GAMES, KEEP_GAMES_MAX, cleanGames, clearGameChoices, gamesOffered, isKeepGame, keepGameName, keepGameOfLink, loadGameChoice,
  openKeepGameLink, parseGamesParam, pickGame, saveGameChoice,
} from './keep-games';

beforeEach(() => { localStorage.clear(); });

describe('the game allowlist', () => {
  it('holds exactly the four built-in games, with their names', () => {
    expect(KEEP_GAMES.map(g => [g.scheme, g.name])).toEqual([
      ['stampede', 'Stampede'], ['twangthang', 'Twang Thang'], ['axenstax', 'AxeNStax'], ['gameflock', 'Cluster Flock'],
    ]);
    expect(keepGameName('gameflock')).toBe('Cluster Flock');
  });

  it.each(['https', 'http', 'javascript', 'intent', 'data', 'file', 'signet-grant', 'Stampede', 'stampede ', '', 'x'.repeat(40), 'stampede:', '//keep'])(
    'does not accept %j', scheme => {
      expect(isKeepGame(scheme)).toBe(false);
      expect(keepGameName(scheme)).toBeUndefined();
    },
  );

  it('does not accept a non-string', () => {
    expect(isKeepGame(undefined)).toBe(false);
    expect(isKeepGame(7)).toBe(false);
    expect(isKeepGame({ toString: () => 'stampede' })).toBe(false);
  });
});

describe('cleanGames', () => {
  it('keeps allowlisted schemes in order, without repeats, and drops everything else', () => {
    expect(cleanGames(['twangthang', 'https', 'stampede', 'twangthang', 'javascript', '9bad', 'intent', 'nope', 5, null]))
      .toEqual(['twangthang', 'stampede']);
  });
  it('is empty for something that is not a list', () => {
    expect(cleanGames(undefined)).toEqual([]);
    expect(cleanGames('stampede')).toEqual([]);
  });
  it('holds at most 16 (the allowlist is shorter, so the cap is a ceiling)', () => {
    expect(cleanGames(Array.from({ length: 100 }, () => 'stampede')).length).toBeLessThanOrEqual(KEEP_GAMES_MAX);
  });
  it('parses a comma-separated parameter', () => {
    expect(parseGamesParam('stampede, axenstax,,https,gameflock')).toEqual(['stampede', 'axenstax', 'gameflock']);
    expect(parseGamesParam('')).toEqual([]);
  });
});

describe('gamesOffered', () => {
  it('is the stored list when it has an allowlisted entry', () => {
    expect(gamesOffered({ games: ['axenstax'] })).toEqual(['axenstax']);
    expect(gamesOffered({ games: ['axenstax', 'https'] })).toEqual(['axenstax']);
  });
  it('is the whole allowlist when nothing is stored, when the list is empty, or when none of it is allowlisted', () => {
    const all = KEEP_GAMES.map(g => g.scheme);
    expect(gamesOffered({})).toEqual(all);
    expect(gamesOffered({ games: [] })).toEqual(all);
    expect(gamesOffered({ games: ['https', 'javascript'] })).toEqual(all);
  });
});

describe('keepGameOfLink', () => {
  it('names the game of an allowlisted Keep link and nothing else', () => {
    expect(keepGameOfLink('twangthang://keep/aa/bb')).toBe('twangthang');
    expect(keepGameOfLink('https://keep/aa/bb')).toBeNull();
    expect(keepGameOfLink('javascript://keep/aa')).toBeNull();
    expect(keepGameOfLink('intent://keep/aa')).toBeNull();
    expect(keepGameOfLink('stampede://other/aa')).toBeNull();
    expect(keepGameOfLink(undefined)).toBeNull();
  });
});

describe('the last game chosen for a Keep', () => {
  it('is remembered per Keep, ignores junk and is cleared on request', () => {
    expect(loadGameChoice('k1')).toBeNull();
    saveGameChoice('k1', 'axenstax');
    saveGameChoice('k2', 'https');
    expect(loadGameChoice('k1')).toBe('axenstax');
    expect(loadGameChoice('k2')).toBeNull();
    localStorage.setItem('signet:keep-game:k3', 'javascript');
    expect(loadGameChoice('k3')).toBeNull();
    clearGameChoices();
    expect(loadGameChoice('k1')).toBeNull();
  });
  it('pickGame: requested, else last used, else first offered; each only if offered', () => {
    const offered = ['stampede', 'axenstax'];
    expect(pickGame(offered, 'axenstax', 'stampede')).toBe('axenstax');
    expect(pickGame(offered, 'gameflock', 'axenstax')).toBe('axenstax');
    expect(pickGame(offered, null, 'twangthang')).toBe('stampede');
    expect(pickGame(offered, undefined, null)).toBe('stampede');
  });
});

describe('openKeepGameLink', () => {
  it('opens an allowlisted game\'s Keep link and nothing else', () => {
    const open = vi.fn();
    const ok = `axenstax://keep/${'ab'.repeat(32)}/${'cd'.repeat(32)}`;
    expect(openKeepGameLink(ok, open)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(ok);
    open.mockClear();
    for (const bad of ['https://example.com/keep/x', 'javascript://keep/x', 'intent://keep/x#Intent;end', 'unknowngame://keep/x', 'stampede://other/x', 'STAMPEDE://keep/x', '', 42, null, undefined]) {
      expect(openKeepGameLink(bad, open)).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
