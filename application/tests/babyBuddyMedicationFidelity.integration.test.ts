import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { buildBabyBuddyImportRecords } from '@/src/lib/importers/baby-buddy';
import { mapBabyBuddyMedicationEntry } from '@/src/lib/importers/baby-buddy/medication-map';
import { executeExternalImport } from '@/src/lib/importers/execute';
import type { ExternalImportExecutionConfiguration, ExternalImportRecord } from '@/src/types/external-import';

let db: PrismaClient;
let directory: string;
const configuration: ExternalImportExecutionConfiguration = {
  sourceTimezone: 'America/Chicago',
  childDestinations: { '7': { mode: 'existing', targetBabyId: 'med-child' } },
};
const sourceRow = { id: 'unknown-1', child_id: '7', time: '2026-10-20 08:15:00',
  name: 'Synthetic supplement', dosage_unit: 'unrecognized source unit',
  next_dose_interval: 'source interval not normalized', notes: 'Original synthetic observation' };
const run = (records: readonly ExternalImportRecord[], familyId = 'med-family') =>
  db.$transaction(tx => executeExternalImport(tx, { familyId, caretakerId: 'med-caretaker', records, configuration }));

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-med-fidelity-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [
    { id: 'med-family', slug: 'med-synthetic', name: 'Synthetic Family' },
    { id: 'med-other-family', slug: 'med-other-synthetic', name: 'Other Synthetic Family' },
  ] });
  await db.baby.create({ data: { id: 'med-child', familyId: 'med-family', firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') } });
  await db.caretaker.create({ data: { id: 'med-caretaker', familyId: 'med-family', name: 'Synthetic Caregiver', type: 'Parent', loginId: 'med-synthetic-caregiver', securityPin: '123456' } });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
}, 90_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('Baby Buddy missing medication dose fidelity', () => {
  it.each([undefined, '', '   '])('preserves absent amount %s as an explicitly unresolved source note', dosage => {
    const record = mapBabyBuddyMedicationEntry({ ...sourceRow, ...(dosage === undefined ? {} : { dosage }) });
    expect(record).toMatchObject({ targetType: 'note', time: '2026-10-20T08:15:00',
      source: { entityType: 'medication', recordId: 'unknown-1', childId: '7' } });
    expect(record).not.toHaveProperty('doseAmount');
    if (record.targetType !== 'note') throw new Error('Expected unresolved note');
    for (const value of [sourceRow.name, 'not recorded in the source', sourceRow.dosage_unit,
      sourceRow.next_dose_interval, sourceRow.notes]) expect(record.content).toContain(value);
  });

  it('keeps an explicit zero and rejects a nonempty invalid amount', () => {
    expect(mapBabyBuddyMedicationEntry({ ...sourceRow, dosage: '0', dosage_unit: 'ml' }))
      .toMatchObject({ targetType: 'medicine', doseAmount: 0, unitAbbr: 'ML' });
    expect(() => mapBabyBuddyMedicationEntry({ ...sourceRow, dosage: 'illegible' })).toThrow();
  });

  it('persists unknown and known source doses transactionally with correct time, ownership, and replay', async () => {
    const records = buildBabyBuddyImportRecords([{ name: 'Medication.csv', content: [
      'id,child_id,time,name,dosage,dosage_unit,notes,next_dose_interval',
      'unknown-1,7,2026-10-20 08:15:00,Synthetic supplement,,drops,Original synthetic observation,04:00:00',
      'known-1,7,2026-10-20 09:15:00,Synthetic measured medicine,2.5,ml,Recorded synthetic dose,06:00:00',
      'explicit-zero,7,2026-10-20 10:15:00,Synthetic zero medicine,0,ml,Explicit source zero,',
    ].join('\n') }], {});
    const result = await run(records);
    expect(result.created).toBe(3);
    const note = await db.note.findFirstOrThrow({ where: { babyId: 'med-child' } });
    expect(note).toMatchObject({ familyId: 'med-family', caretakerId: 'med-caretaker',
      time: new Date('2026-10-20T13:15:00Z') });
    expect(note.content).toContain('Dose amount: not recorded in the source.');
    expect(note.content).toContain('Source dose unit: drops');
    expect(note.content).toContain('Source next-dose interval: 04:00:00');
    expect(note.content).toContain('Original synthetic observation');
    expect(await db.medicineLog.findMany({ orderBy: { time: 'asc' } })).toMatchObject([
      { doseAmount: 2.5, time: new Date('2026-10-20T14:15:00Z'), familyId: 'med-family', caretakerId: 'med-caretaker' },
      { doseAmount: 0, time: new Date('2026-10-20T15:15:00Z') },
    ]);
    expect(await db.medicine.count()).toBe(2);
    expect(await db.externalImportRecord.findFirstOrThrow({ where: { sourceRecordId: 'unknown-1' } }))
      .toMatchObject({ sourceEntityType: 'medication', targetEntityType: 'Note', targetRecordId: note.id });
    const replay = await run(records);
    expect(replay).toMatchObject({ created: 0, duplicates: 3 });
    expect(replay.records.map(row => row.targetRecordId)).toEqual(result.records.map(row => row.targetRecordId));
    expect(await db.note.count()).toBe(1);
    expect(await db.medicineLog.count()).toBe(2);
    expect(await db.externalImportRecord.count()).toBe(3);
  });

  it('rejects wrong-family child ownership before creating any observation', async () => {
    const records = [mapBabyBuddyMedicationEntry({ ...sourceRow, id: 'wrong-family-attempt' })];
    await expect(run(records, 'med-other-family')).rejects.toThrow('not found in this family');
    expect(await db.note.count({ where: { familyId: 'med-other-family' } })).toBe(0);
    expect(await db.externalImportRecord.count({ where: { sourceRecordId: 'wrong-family-attempt' } })).toBe(0);
  });

  it('rolls back the whole import if a later source time cannot be converted', async () => {
    const records = [mapBabyBuddyMedicationEntry({ ...sourceRow, id: 'rollback-first' }),
      { ...mapBabyBuddyMedicationEntry({ ...sourceRow, id: 'rollback-second' }), time: 'invalid-time' }];
    const before = await db.note.count();
    await expect(run(records)).rejects.toThrow();
    expect(await db.note.count()).toBe(before);
    expect(await db.externalImportRecord.count({ where: { sourceRecordId: { startsWith: 'rollback-' } } })).toBe(0);
  });

  it('preserves existing older zero imports and reports their actual persisted target on replay', async () => {
    const medicine = await db.medicine.create({ data: { name: 'Synthetic legacy medicine', familyId: 'med-family' } });
    const old = await db.medicineLog.create({ data: { familyId: 'med-family', babyId: 'med-child', medicineId: medicine.id,
      time: new Date('2026-10-19T13:15:00Z'), doseAmount: 0, notes: 'Unchanged legacy source' } });
    await db.externalImportRecord.create({ data: { familyId: 'med-family', providerId: 'baby-buddy', sourceEntityType: 'medication',
      sourceRecordId: 'legacy-unknown', sourceChildId: '7', targetEntityType: 'MedicineLog', targetRecordId: old.id } });
    const before = await db.note.count();
    const result = await run([mapBabyBuddyMedicationEntry({ ...sourceRow, id: 'legacy-unknown' })]);
    expect(result).toMatchObject({ created: 0, duplicates: 1,
      records: [{ targetEntityType: 'MedicineLog', targetRecordId: old.id, status: 'duplicate' }] });
    expect(await db.medicineLog.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db.note.count()).toBe(before);
  });
});
