import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parsePumpSessionSnapshot,
  pumpSessionKey,
  loadPumpSession,
  readPumpSession,
  savePumpSession,
  clearPumpSession,
  preparePumpSubmission,
  mutatePumpSession,
  PumpSessionSnapshot,
} from '@/src/utils/nursery/pumpSession';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const validSnapshot: PumpSessionSnapshot = {
  phase: 'timing',
  activeSide: 'left',
  startTime: '2026-07-14T10:00:00.000Z',
  sideDuration: { left: 30, right: 0 },
  pauseAccumulated: 0,
  resumeTime: 1752480000000,
  elapsed: 45,
  amountLeft: '',
  amountRight: '',
};
const scope = JSON.stringify(['family-1', 'caretaker:caregiver-1', 'baby-1']);
const stopped: PumpSessionSnapshot = { ...validSnapshot, phase: 'selecting_action', activeSide: 'both',
  requestId: '78d29686-5eb2-48ee-a7ec-756853e2bcf3', scope, unitAbbr: 'ML',
  endTime: '2026-07-14T10:12:00.000Z', resumeTime: null, elapsed: 600, pauseAccumulated: 600,
  sideDuration: { left: 120, right: 0 }, amountLeft: '0', amountRight: ' 55.5 ' };

describe('parsePumpSessionSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parsePumpSessionSnapshot(validSnapshot)).toEqual(validSnapshot);
  });

  it('rejects non-object input', () => {
    expect(parsePumpSessionSnapshot(null)).toBeNull();
    expect(parsePumpSessionSnapshot('nope')).toBeNull();
    expect(parsePumpSessionSnapshot([1, 2, 3])).toBeNull();
  });

  it('rejects an invalid phase', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, phase: 'idle' })).toBeNull();
    expect(parsePumpSessionSnapshot({ ...validSnapshot, phase: 'bogus' })).toBeNull();
  });

  it('rejects an invalid activeSide', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, activeSide: 'up' })).toBeNull();
  });

  it('rejects an unparsable startTime', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, startTime: 'not-a-date' })).toBeNull();
  });

  it('rejects a malformed sideDuration', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, sideDuration: { left: -1, right: 0 } })).toBeNull();
    expect(parsePumpSessionSnapshot({ ...validSnapshot, sideDuration: null })).toBeNull();
  });

  it('accepts a null resumeTime (paused session)', () => {
    const paused = { ...validSnapshot, phase: 'paused' as const, resumeTime: null };
    expect(parsePumpSessionSnapshot(paused)).toEqual(paused);
  });

  it('rejects a non-numeric resumeTime', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, resumeTime: 'now' })).toBeNull();
  });

  it('rejects non-string amount fields', () => {
    expect(parsePumpSessionSnapshot({ ...validSnapshot, amountLeft: 4 })).toBeNull();
  });
});

describe('pumpSessionKey', () => {
  it('scopes the storage key per baby', () => {
    expect(pumpSessionKey('baby-1')).toBe('nurseryPumpSessionV1:baby-1');
    expect(pumpSessionKey('baby-2')).not.toBe(pumpSessionKey('baby-1'));
  });
});

describe('save/load/clear round-trip', () => {
  beforeEach(() => {
    (globalThis as any).window = { localStorage: new MemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('round-trips a saved snapshot', () => {
    savePumpSession('baby-1', validSnapshot);
    expect(loadPumpSession('baby-1')).toEqual(validSnapshot);
  });

  it('keeps sessions for different babies isolated', () => {
    savePumpSession('baby-1', validSnapshot);
    expect(loadPumpSession('baby-2')).toBeNull();
  });

  it('returns null when nothing is saved', () => {
    expect(loadPumpSession('baby-1')).toBeNull();
  });

  it('clears a saved session', () => {
    savePumpSession('baby-1', validSnapshot);
    clearPumpSession('baby-1');
    expect(loadPumpSession('baby-1')).toBeNull();
  });

  it('ignores corrupt JSON instead of throwing', () => {
    window.localStorage.setItem(pumpSessionKey('baby-1'), '{not json');
    expect(loadPumpSession('baby-1')).toBeNull();
  });

  it('is a no-op without a babyId', () => {
    savePumpSession('', validSnapshot);
    expect(loadPumpSession('')).toBeNull();
  });

  it('isolates original family, caregiver and child while leaving legacy drafts available for explicit review', () => {
    expect(savePumpSession('baby-1', validSnapshot)).toBe(true);
    expect(savePumpSession('baby-1', stopped, scope)).toBe(true);
    expect(loadPumpSession('baby-1', scope)).toEqual(stopped);
    for (const otherScope of [
      JSON.stringify(['family-2', 'caretaker:caregiver-1', 'baby-1']),
      JSON.stringify(['family-1', 'caretaker:caregiver-2', 'baby-1']),
      JSON.stringify(['family-1', 'account:caregiver-1', 'baby-1']),
      JSON.stringify(['family-1', 'caretaker:caregiver-1', 'baby-2']),
    ]) expect(loadPumpSession('baby-1', otherScope)).toBeNull();
    expect(loadPumpSession('baby-2', scope)).toBeNull();
    clearPumpSession('baby-1', scope);
    expect(loadPumpSession('baby-1', scope)).toBeNull();
    expect(loadPumpSession('baby-1')).toEqual(validSnapshot);
  });

  it('retains the exact frozen submission and timer details across a browser restart', () => {
    const pending = preparePumpSubmission(stopped, 'baby-1', 'FED');
    const frozen = { ...stopped, pumpAction: 'FED' as const, pending };
    expect(savePumpSession('baby-1', frozen, scope)).toBe(true);
    expect(loadPumpSession('baby-1', scope)).toEqual(frozen);
    expect(pending).toEqual({ requestId: stopped.requestId, expectedScope: scope, babyId: 'baby-1',
      startTime: stopped.startTime, endTime: stopped.endTime, duration: 12, pumpAction: 'FED',
      unitAbbr: 'ML', leftAmount: 0, rightAmount: 55.5 });
  });

  it('fails closed when storage rejects or cannot verify the request before dispatch', () => {
    window.localStorage.setItem = () => { throw new Error('Storage is full'); };
    expect(savePumpSession('baby-1', stopped, scope)).toBe(false);
    window.localStorage.setItem = () => {};
    expect(savePumpSession('baby-1', stopped, scope)).toBe(false);
  });

  it('distinguishes an explicitly missing draft from unreadable storage or malformed data', () => {
    expect(readPumpSession('baby-1', scope)).toEqual({ status: 'missing' });
    window.localStorage.setItem(pumpSessionKey('baby-1', scope), '{broken');
    expect(readPumpSession('baby-1', scope)).toEqual({ status: 'invalid' });
    window.localStorage.getItem = () => { throw new Error('Storage is unavailable'); };
    expect(readPumpSession('baby-1', scope)).toEqual({ status: 'unavailable' });
  });
});

describe('preparePumpSubmission', () => {
  it.each([0, 20, 29, 30, 60])('rounds actual active seconds %i without inventing a minimum minute', elapsed => {
    expect(preparePumpSubmission({ ...stopped, sideDuration: { left: 0, right: 0 }, elapsed }, 'baby-1', 'STORED').duration).toBe(Math.round(elapsed / 60));
  });
  it('keeps absent amounts distinct from explicit zero and retains original unit', () => {
    const pending = preparePumpSubmission({ ...stopped, amountLeft: '', amountRight: '0', unitAbbr: 'OZ' }, 'baby-1', 'DISCARDED');
    expect(pending).not.toHaveProperty('leftAmount');
    expect(pending.rightAmount).toBe(0); expect(pending.unitAbbr).toBe('OZ');
    expect(pending.pumpAction).toBe('DISCARDED'); expect(pending.endTime).toBe(stopped.endTime);
  });

  it.each(['-1', '12abc', 'Infinity', 'NaN', '1e99'])('rejects invalid amount %s without mutating the draft', value => {
    const draft = { ...stopped, amountLeft: value };
    const before = structuredClone(draft);
    expect(() => preparePumpSubmission(draft, 'baby-1', 'STORED')).toThrow('Enter a valid non-negative pumping amount.');
    expect(draft).toEqual(before);
  });

  it('requires original identity and stopped endpoint instead of inventing replacements', () => {
    expect(() => preparePumpSubmission(validSnapshot, 'baby-1', 'STORED')).toThrow();
    expect(() => preparePumpSubmission(stopped, 'baby-2', 'STORED')).toThrow();
    expect(() => preparePumpSubmission({ ...stopped, endTime: undefined }, 'baby-1', 'STORED')).toThrow();
    expect(() => preparePumpSubmission({ ...stopped, endTime: '2026-07-14T09:00:00Z' }, 'baby-1', 'STORED')).toThrow();
  });

  it('rejects malformed or mixed-owner persisted requests instead of sending them for another child', () => {
    const pending = preparePumpSubmission(stopped, 'baby-1', 'FED');
    const frozen = { ...stopped, pumpAction: 'FED' as const, pending };
    for (const change of [
      { pending: { ...pending, requestId: 'd4d0278e-86a9-413d-993c-1bf88fe19df0' } },
      { pending: { ...pending, babyId: 'baby-2' } },
      { pending: { ...pending, endTime: '2026-07-14T10:15:00Z' } },
      { pending: { ...pending, pumpAction: 'STORED' } },
      { pending: { ...pending, leftAmount: -1 } },
      { requestId: undefined }, { scope: 'not-a-scope' }, { unitAbbr: undefined },
    ]) expect(parsePumpSessionSnapshot({ ...frozen, ...change })).toBeNull();
  });
});

describe('serialized scoped draft mutations', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: new MemoryStorage() });
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, callback: () => unknown) => callback() } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed without Web Locks before mutating local storage', async () => {
    vi.stubGlobal('navigator', {});
    expect(await mutatePumpSession('baby-1', scope, { kind: 'create', snapshot: stopped })).toEqual({ status: 'locking-unavailable' });
    expect(loadPumpSession('baby-1', scope)).toBeNull();
  });

  it('cannot replace another request ID, remove its draft, or unfreeze a dispatched payload with a stale timer snapshot', async () => {
    const pending = preparePumpSubmission(stopped, 'baby-1', 'FED');
    const frozen = { ...stopped, pumpAction: 'FED' as const, pending };
    expect((await mutatePumpSession('baby-1', scope, { kind: 'create', snapshot: stopped })).status).toBe('saved');
    const [dispatch, staleTimer] = await Promise.all([
      mutatePumpSession('baby-1', scope, { kind: 'save', snapshot: frozen }),
      mutatePumpSession('baby-1', scope, { kind: 'save', snapshot: stopped }),
    ]);
    expect(dispatch.status).toBe('saved'); expect(staleTimer).toEqual({ status: 'changed', snapshot: frozen });
    expect(await mutatePumpSession('baby-1', scope, { kind: 'remove', requestId: stopped.requestId!, pending: { ...pending, leftAmount: 99 } })).toEqual({ status: 'changed', snapshot: frozen });
    const newer = { ...stopped, requestId: 'd4d0278e-86a9-413d-993c-1bf88fe19df0' };
    expect(await mutatePumpSession('baby-1', scope, { kind: 'create', snapshot: newer })).toEqual({ status: 'changed', snapshot: frozen });
    expect(loadPumpSession('baby-1', scope)).toEqual(frozen);
    expect((await mutatePumpSession('baby-1', scope, { kind: 'remove', requestId: pending.requestId, pending })).status).toBe('removed');
    expect((await mutatePumpSession('baby-1', scope, { kind: 'create', snapshot: newer })).status).toBe('saved');
    expect(await mutatePumpSession('baby-1', scope, { kind: 'reject', requestId: pending.requestId, pending })).toEqual({ status: 'changed', snapshot: newer });
    expect(loadPumpSession('baby-1', scope)).toEqual(newer);
  });

  it('only a definite rejection of the current exact request makes amounts editable', async () => {
    const pending = preparePumpSubmission(stopped, 'baby-1', 'FED');
    const frozen = { ...stopped, pumpAction: 'FED' as const, pending };
    await mutatePumpSession('baby-1', scope, { kind: 'create', snapshot: frozen });
    const result = await mutatePumpSession('baby-1', scope, { kind: 'reject', requestId: pending.requestId, pending });
    expect(result).toEqual({ status: 'saved', snapshot: { ...frozen, pending: undefined } });
    expect(loadPumpSession('baby-1', scope)).toEqual({ ...stopped, pumpAction: 'FED' });
    window.localStorage.getItem = () => { throw new Error('Storage unavailable after dispatch'); };
    expect(await mutatePumpSession('baby-1', scope, { kind: 'reject', requestId: pending.requestId, pending })).toEqual({ status: 'unavailable' });
  });
});
