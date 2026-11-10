import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { sealOcrState } from '@/src/lib/ocr/crypto';
import { commitOcrReview, saveOcrReview } from '@/src/lib/ocr/documents';

let db: PrismaClient;
let directory: string;
const previousKey = process.env.ENC_HASH;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-ocr-rich-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  process.env.ENC_HASH = '66'.repeat(32);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.create({ data: { id: 'rich-family', slug: 'rich-synthetic', name: 'Synthetic Family' } });
  await db.baby.create({ data: { id: 'rich-child', familyId: 'rich-family', firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') } });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
}, 90_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.ENC_HASH; else process.env.ENC_HASH = previousKey;
});

describe('reviewed OCR bottle details in the canonical database', () => {
  it('persists corrected metadata in FeedLog and replays confirmation without duplicate feeds', async () => {
    const text = '08:15 bottle formula offered 120 mL consumed 90 mL; concentration: 22 kcal/oz; formula name: Synthetic Brand; bottle id: A-1; caregiver: Synthetic Caregiver; duration: 20 minutes';
    const pages = [{ page: 1, text, engine: 'synthetic-text', confidence: null }];
    const rows = parseOcrPages(pages, { defaultDate: '2026-10-20', timeFormat: '24h' });
    expect(rows).toHaveLength(1);
    expect(rows[0].feedDuration).toBe(1200);
    const id = randomUUID(), actor = { familyId: 'rich-family', actorId: null };
    await db.ocrDocument.create({ data: {
      id, familyId: actor.familyId, babyId: 'rich-child', sourceHash: 'rich-synthetic-' + id,
      originalName: 'synthetic.txt', mimeType: 'image/png', byteSize: 1, previewFiles: '[]',
      pageCount: 1, parserVersion: 'synthetic', sourceTimezone: 'America/Chicago',
      sourceExpiresAt: new Date(Date.now() + 86400000),
      originalState: sealOcrState({ rows, pages }, actor.familyId + ':' + id + ':original'),
      reviewState: sealOcrState({ rows, timeZone: 'America/Chicago' }, actor.familyId + ':' + id + ':review'),
    } });
    const review = { revision: 0, timeZone: 'America/Chicago', acknowledgeWarnings: true, rows: rows.map(row => ({
      ...row, approved: true, feedDuration: 1350, offeredAmount: 125, formulaName: 'Corrected Synthetic Brand',
    })) };
    expect(await db.feedLog.count()).toBe(0);
    await expect(commitOcrReview(db, actor, id, { ...review, rows: [{ ...review.rows[0], feedDuration: -1 }] })).rejects.toThrow('Feeding duration');
    await expect(commitOcrReview(db, actor, id, { ...review, rows: [{ ...review.rows[0], approved: false }] })).rejects.toThrow('Approve');
    const saved = await saveOcrReview(db, actor, id, review);
    expect(saved.rows[0].fieldSources.feedDuration).toBe('corrected');
    expect(saved.originalRows[0].feedDuration).toBe(1200);
    expect(await db.feedLog.count()).toBe(0);
    review.revision = saved.revision;
    const result = await commitOcrReview(db, actor, id, review);
    expect(result.result?.created).toBe(1);
    expect(await db.feedLog.findFirstOrThrow({ where: { babyId: 'rich-child', familyId: actor.familyId } })).toMatchObject({
      amount: 90, feedDuration: 1350, offeredAmount: 125, unitAbbr: 'ML', formulaKcalOz: 22,
      formulaName: 'Corrected Synthetic Brand', bottleLabel: 'A-1',
      sourceCaregiverName: 'Synthetic Caregiver', caretakerId: null,
    });
    expect((await commitOcrReview(db, actor, id, review)).result).toEqual(result.result);
    expect(await db.feedLog.count()).toBe(1);
    expect(await db.externalImportRecord.count()).toBe(1);
    expect(await db.ocrAudit.count({ where: { documentId: id, action: 'commit' } })).toBe(1);
    await expect(commitOcrReview(db, actor, id, { ...review, rows: [{ ...review.rows[0], feedDuration: 1200 }] })).rejects.toThrow('different review');
    expect((await db.feedLog.findFirstOrThrow()).feedDuration).toBe(1350);
  });
});
