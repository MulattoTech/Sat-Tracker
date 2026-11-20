import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { PHOTO_RACE_CASES, runPhotoRace } from '../scripts/photo-integrity-concurrency';

let directory: string, databaseUrl: string, db: PrismaClient;
const familyId = 'synthetic-photo-concurrency-' + randomUUID();
const babyId = familyId + '-child', siblingId = familyId + '-sibling', caretakerId = familyId + '-carer';
beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-photo-concurrency-'));
  databaseUrl = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
  await db.family.create({ data: { id: familyId, name: 'Synthetic photo concurrency', slug: 'photo-race-' + randomUUID().slice(0, 8) } });
  await db.baby.createMany({ data: [babyId, siblingId].map(id => ({ id, familyId, firstName: 'Synthetic', lastName: 'Photo race', birthDate: new Date('2026-01-01Z') })) });
  await db.caretaker.create({ data: { id: caretakerId, familyId, loginId: '43', securityPin: '684239', name: 'Synthetic photo reviewer', role: 'USER' } });
}, 90_000);
afterAll(async () => { await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); });

describe('actual SQLite photo integrity overlap across independent processes', () => {
  it.each(PHOTO_RACE_CASES)('%s observes actual lock contention, preserves invariants and leaves both writers usable', async scenario => {
    const receipt = await runPhotoRace(db, { databaseUrl, familyId, babyId, siblingId, caretakerId, scenario });
    expect(receipt.provider).toBe('sqlite'); expect(receipt.bothClientsCommittedAfterContention).toBe(true);
    expect(receipt.familyScalarsPreserved).toBe(true); expect(receipt.lockAttempts).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
