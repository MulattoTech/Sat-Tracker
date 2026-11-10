import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readOcrRedactionOptions, redactOcrText } from '@/src/lib/ocr/redaction';

const redact = vi.hoisted(() => vi.fn(async () => ({ id: 'synthetic-document' })));
vi.mock('@/app/api/db', () => ({ default: {} }));
vi.mock('@/src/lib/ocr/documents', () => ({ redactOcrDocument: redact }));
vi.mock('@/app/api/utils/auth', () => ({
  withAuthContext: (handler: (request: NextRequest, actor: unknown) => unknown) => (request: NextRequest) => handler(request, {
    authenticated: true, familyId: 'synthetic-family', caretakerRole: 'ADMIN', caretakerId: null,
  }),
}));
vi.mock('@/app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
import { POST } from '@/app/api/ocr/documents/[id]/redact/route';

const url = 'http://localhost/api/ocr/documents/11111111-1111-4111-8111-111111111111/redact';
beforeEach(() => { vi.clearAllMocks(); });

describe('OCR redaction request boundary', () => {
  it('removes rich OCR free text while preserving measured quantities and provenance IDs', () => {
    const input = { rows: [{ notes: 'private', sourceCaregiverName: 'Caregiver', formulaName: 'Brand', bottleLabel: 'Label',
      amount: 90, unit: 'ML', source: { page: 1, rawText: 'private source' } }], sourceHash: 'stable-hash' };
    const redacted = redactOcrText(input);
    expect(redacted.rows[0]).toEqual({ notes: '[REDACTED]', sourceCaregiverName: '[REDACTED]', formulaName: '[REDACTED]',
      bottleLabel: '[REDACTED]', amount: 90, unit: 'ML', source: { page: 1, rawText: '[REDACTED]' } });
    expect(redacted.sourceHash).toBe('stable-hash');
    expect(input.rows[0].notes).toBe('private');
  });
  it.each(['{', '', 'null', '[]', '"purge"', '{"redactNotes":"false"}', '{"purgeSource":1}', '{"purgeSouce":true}'])(
    'rejects invalid body %s without a redaction call', async body => {
      const response = await POST(new NextRequest(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }));
      expect(response.status).toBe(400);
      expect(redact).not.toHaveBeenCalled();
    },
  );

  it('preserves the body-size rejection instead of purging on a 413', async () => {
    const response = await POST(new NextRequest(url, {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024 + 1) },
    }));
    expect(response.status).toBe(413);
    expect(redact).not.toHaveBeenCalled();
  });

  it('passes explicit choices to the scoped service', async () => {
    const response = await POST(new NextRequest(url, { method: 'POST', body: '{"redactNotes":true,"purgeSource":false}' }));
    expect(response.status).toBe(200);
    expect(redact).toHaveBeenCalledWith({}, { familyId: 'synthetic-family', actorId: null },
      '11111111-1111-4111-8111-111111111111', { redactNotes: true, purgeSource: false });
    expect(readOcrRedactionOptions({})).toEqual({ redactNotes: true, purgeSource: true });
  });
});
