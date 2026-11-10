/** A local storage namespace, never an authorization decision. The API compares
 * it with authenticated middleware before accepting a queued write. */
export function journalScope(familyId: string, actorKey: string, babyId: string): string {
  return JSON.stringify([familyId, actorKey, babyId]);
}

export function journalScopeFromToken(token: string | null, familyId?: string, babyId?: string): string | null {
  if (!token || !familyId || !babyId) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.isSysAdmin || payload.isSetupAuth || payload.familyId !== familyId) return null;
    const id = payload.isAccountAuth ? payload.accountId : payload.id;
    if (typeof id !== 'string' || !id || id.length > 100) return null;
    return journalScope(familyId, `${payload.isAccountAuth ? 'account' : 'caretaker'}:${id}`, babyId);
  } catch { return null; }
}
