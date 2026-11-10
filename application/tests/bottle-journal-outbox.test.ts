import { describe, expect, it } from 'vitest';
import { journalScope, journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { retryableStatus } from '@/src/lib/bottle-journal/outbox';

const token = (payload: unknown) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
describe('Journal outbox identity and retries', () => {
  it('isolates caregiver, account, family and child namespaces without retaining credentials', () => {
    const jwt = token({ id: 'parent-a', familyId: 'family-a' });
    const scope = journalScopeFromToken(jwt, 'family-a', 'child-a');
    expect(scope).toBe(journalScope('family-a', 'caretaker:parent-a', 'child-a'));
    expect(scope).not.toContain(jwt);
    expect(journalScopeFromToken(jwt, 'family-b', 'child-a')).toBeNull();
    expect(journalScopeFromToken(jwt, 'family-a', 'child-b')).not.toBe(scope);
    expect(journalScopeFromToken(token({ id: 'parent-b', familyId: 'family-a' }), 'family-a', 'child-a')).not.toBe(scope);
    expect(journalScopeFromToken(token({ id: 'parent-a', accountId: 'parent-a', isAccountAuth: true, familyId: 'family-a' }), 'family-a', 'child-a')).not.toBe(scope);
  });
  it('fails closed for missing, malformed, setup and unbound administrator sessions', () => {
    for (const jwt of [null, '', 'broken', 'a.e30=.x', token({ id: 'a', familyId: 'family-a', isSetupAuth: true }), token({ id: 'a', familyId: 'family-a', isSysAdmin: true })]) {
      expect(journalScopeFromToken(jwt, 'family-a', 'child-a')).toBeNull();
    }
  });
  it('allows token refresh to keep the same local namespace', () => {
    expect(journalScopeFromToken(token({ id: 'a', familyId: 'f', exp: 1 }), 'f', 'b'))
      .toBe(journalScopeFromToken(token({ id: 'a', familyId: 'f', exp: 9999999999 }), 'f', 'b'));
  });
  it('retries uncertain/transient delivery but requires review for validation, access and conflicts', () => {
    for (const status of [0, 408, 429, 500, 502, 503]) expect(retryableStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 413, 422]) expect(retryableStatus(status)).toBe(false);
  });
});
