/**
 * Scoped production-baseline security regression for feedback attachment reads and deletion.
 *
 * Synthetic principals and attachment metadata only. No existing installation, keys,
 * image filesystem or real family record is used. Actual packaged HTTP coverage is
 * separately required before this maintenance candidate can be released.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type SyntheticAttachment = {
  id: string;
  storedName: string;
  mimeType: string;
  feedback: {
    familyId: string | null;
    caretakerId: string | null;
    accountId: string | null;
    parentId: string | null;
    parent: { caretakerId: string | null; accountId: string | null } | null;
  };
};

const state = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  actors: new Map<string, unknown>(),
  removedRows: [] as string[],
  decrypt: vi.fn(() => Buffer.from('synthetic encrypted-image plaintext')),
  removeCiphertext: vi.fn(),
}));

vi.mock('../app/api/db', () => ({
  default: {
    feedbackAttachment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.entries.get(where.id) ?? null),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const original = state.entries.get(where.id);
        state.entries.delete(where.id);
        state.removedRows.push(where.id);
        return original;
      }),
    },
  },
}));

vi.mock('../src/lib/file-encryption', () => ({
  decryptFile: state.decrypt,
  deleteEncryptedFile: state.removeCiphertext,
}));

// Real JWT/login and encrypted-file integration is separately tested against the
// immutable image. Here, only the route's authority boundary is isolated.
vi.mock('../app/api/utils/auth', () => ({
  withAuthContext: (handler: (req: NextRequest, auth: unknown) => Promise<Response>) =>
    async (req: NextRequest) => {
      const header = req.headers.get('authorization') ?? '';
      const principal = header.startsWith('Bearer ') ? state.actors.get(header.slice(7)) : null;
      if (!principal) return Response.json({ success: false, error: 'Authentication required' }, { status: 401 });
      return handler(req, principal);
    },
}));

import { GET, DELETE } from '../app/api/feedback/file/[id]/route';

function actor(
  familyId: string | null,
  caretakerId: string | null,
  role: 'ADMIN' | 'USER',
  isSysAdmin = false,
) {
  return {
    authenticated: true, familyId, caretakerId, caretakerRole: role,
    isSysAdmin, isAccountAuth: false, accountId: null, isSetupAuth: false,
  };
}

function attachment(id: string, familyId: string, caretakerId: string): SyntheticAttachment {
  return {
    id, storedName: id + '.enc', mimeType: 'image/png',
    feedback: { familyId, caretakerId, accountId: null, parentId: null, parent: null },
  };
}

function request(method: string, id: string, token?: string) {
  return new NextRequest('http://synthetic.invalid/api/feedback/file/' + id, {
    method, headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
}

beforeEach(() => {
  state.entries.clear(); state.actors.clear(); state.removedRows.length = 0;
  vi.clearAllMocks();

  state.entries.set('entry', attachment('entry', 'family-a', 'submitter-a'));
  state.entries.set('delete-entry', attachment('delete-entry', 'family-a', 'submitter-a'));
  state.entries.set('reply-entry', {
    ...attachment('reply-entry', 'family-a', 'replier-a'),
    feedback: {
      familyId: 'family-a', caretakerId: 'replier-a', accountId: null,
      parentId: 'original-thread', parent: { caretakerId: 'submitter-a', accountId: null },
    },
  });

  state.actors.set('same-family-admin', actor('family-a', 'admin-a', 'ADMIN'));
  state.actors.set('foreign-family-admin', actor('family-b', 'admin-b', 'ADMIN'));
  state.actors.set('foreign-family-user', actor('family-b', 'caretaker-b', 'USER'));
  state.actors.set('admin-no-family', actor(null, 'unrelated-admin', 'ADMIN'));
  state.actors.set('submitter-a', actor('family-a', 'submitter-a', 'USER'));
  state.actors.set('installation-admin', actor(null, null, 'ADMIN', true));
});

describe('feedback attachment family boundary on production baseline', () => {
  it.each(['foreign-family-admin', 'foreign-family-user', 'admin-no-family'])(
    'denies attachment reads to %s before attempting decryption', async token => {
      const response = await GET(request('GET', 'entry', token));
      expect(response.status).toBe(404);
      expect(state.decrypt).not.toHaveBeenCalled();
    },
  );

  it('rejects foreign-family ADMIN deletion without deleting a row or ciphertext', async () => {
    const before = state.entries.get('delete-entry');
    const response = await DELETE(request('DELETE', 'delete-entry', 'foreign-family-admin'));
    expect(response.status).toBe(404);
    expect(state.entries.get('delete-entry')).toBe(before);
    expect(state.removedRows).toEqual([]);
    expect(state.removeCiphertext).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
  });

  it.each(['same-family-admin', 'submitter-a', 'installation-admin'])(
    'preserves %s legitimate access', async token => {
      const response = await GET(request('GET', 'entry', token));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(await response.text()).toBe('synthetic encrypted-image plaintext');
      expect(state.decrypt).toHaveBeenCalledWith('entry.enc', 'feedback');
    },
  );

  it('allows the original submitter to access their feedback reply', async () => {
    const response = await GET(request('GET', 'reply-entry', 'submitter-a'));
    expect(response.status).toBe(200);
    expect(state.decrypt).toHaveBeenCalledWith('reply-entry.enc', 'feedback');
  });

  it('requires authentication before reading an attachment', async () => {
    const response = await GET(request('GET', 'entry'));
    expect(response.status).toBe(401);
    expect(state.decrypt).not.toHaveBeenCalled();
  });
});