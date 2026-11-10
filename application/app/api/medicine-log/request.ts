import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma, type MedicineLog, type PrismaClient } from '@prisma/client';
import type { AuthResult } from '../utils/auth';
import type { MedicineLogCreate } from '../types';
import { CareWriteError, requireCareBaby } from '../utils/care-write';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';
import { toUTC } from '../utils/timezone';

const PROVIDER = 'sat-tracker-medicine-dose-v1';
const reviewMessage = 'This dose was already saved and later changed or removed. Review the care log before dismissing the saved request.';
class MedicineDoseConflict extends CareWriteError {
  constructor(message: string, readonly code: 'DOSE_CHANGED' | 'DOSE_SCOPE_CHANGED' | 'DOSE_BUSY') { super(message, 409); }
  response() { return NextResponse.json({ success: false, error: this.message, code: this.code }, { status: this.status }); }
}
const busy = () => new MedicineDoseConflict('This dose is being saved. Keep the saved request and retry after the other request finishes.', 'DOSE_BUSY');
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 };

function contention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && ['P2034', 'P1008', 'P2028'].includes(String(error.code))) return true;
  const cause = 'cause' in error ? error.cause : null;
  return !!cause && typeof cause === 'object' && 'originalCode' in cause
    && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(String(cause.originalCode));
}

export type MedicineDoseCreate = MedicineLogCreate & { requestId?: string; expectedScope?: string };

/** The optional metadata is strict when supplied. Auth middleware establishes
 * the owner; a browser scope can only assert which owner the caregiver intended. */
function requestIdentity(body: MedicineDoseCreate, auth: AuthResult) {
  if (body.requestId === undefined && body.expectedScope === undefined) return null;
  if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(body.requestId)
    || typeof body.expectedScope !== 'string') throw new CareWriteError('A valid dose request ID and caregiver scope are required.');
  const actor = auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}`
    : auth.caretakerId ? `caretaker:${auth.caretakerId}` : null;
  if (!auth.familyId || !actor || auth.isSetupAuth || auth.isSysAdmin
    || body.expectedScope !== journalScope(auth.familyId, actor, body.babyId)) {
    throw new MedicineDoseConflict('The caregiver or child changed. Sign in as the original caregiver and select the original child before retrying this dose.', 'DOSE_SCOPE_CHANGED');
  }
  return { requestId: body.requestId, actor };
}

/** A create receipt outlives hard deletion. The request UUID distinguishes
 * deliberate identical administrations; the canonical payload in the target
 * identity prevents changing an old request to match a later correction. */
export async function createMedicineDose(db: PrismaClient, auth: AuthResult, body: MedicineDoseCreate) {
  const identity = requestIdentity(body, auth);
  const familyId = auth.familyId!;
  const data = {
    familyId, babyId: body.babyId, medicineId: body.medicineId, caretakerId: auth.caretakerId ?? null,
    time: toUTC(body.time), doseAmount: body.doseAmount, unitAbbr: body.unitAbbr ?? null, notes: body.notes ?? null,
  };
  const doseId = identity ? 'dose-' + createHash('sha256').update(JSON.stringify([
    familyId, identity.actor, identity.requestId, data,
  ])).digest('hex') : undefined;
  const receiptWhere = identity ? { familyId, providerId: PROVIDER, sourceEntityType: 'medicine-dose', sourceRecordId: identity.requestId } : null;

  const replay = async (tx: Prisma.TransactionClient): Promise<MedicineLog | null> => {
    if (!receiptWhere) return null;
    const receipt = await tx.externalImportRecord.findUnique({ where: { familyId_providerId_sourceEntityType_sourceRecordId: receiptWhere } });
    if (!receipt) return null;
    if (receipt.targetEntityType !== 'MedicineLog' || receipt.targetRecordId !== doseId || receipt.sourceChildId !== body.babyId) {
      throw new MedicineDoseConflict(reviewMessage, 'DOSE_CHANGED');
    }
    const saved = await tx.medicineLog.findUnique({ where: { id: doseId! } });
    if (!saved || saved.deletedAt !== null
      || !Object.entries(data).every(([field, value]) => {
        const actual = saved[field as keyof MedicineLog];
        return value instanceof Date ? actual instanceof Date && actual.getTime() === value.getTime() : actual === value;
      })
      || saved.createdAt.getTime() !== receipt.importedAt.getTime()
      || saved.updatedAt.getTime() !== receipt.importedAt.getTime()) throw new MedicineDoseConflict(reviewMessage, 'DOSE_CHANGED');
    return saved;
  };

  const references = async (tx: Prisma.TransactionClient) => {
    await requireCareBaby(tx, body.babyId, familyId);
    const medicine = await tx.medicine.findFirst({ where: { id: body.medicineId, familyId, deletedAt: null }, select: { name: true, isSupplement: true } });
    if (!medicine) throw new CareWriteError('Medicine not found in this family.', 404);
    return medicine;
  };
  try {
    // Read-only replay uses autocommit queries, not a second transaction that
    // could hold a SQLite read lock while another connection commits a dose.
    const saved = await replay(db);
    const medicine = await references(db);
    if (saved) return { medicineLog: saved, medicine, created: false };
    return await db.$transaction(async tx => {
      // Acquire the write before reading relationships. Separate deferred
      // SQLite readers upgrading to writers can deadlock at COMMIT and leave
      // the adapter unusable. All ownership/live checks still precede commit,
      // and a failed check rolls this insert and its receipt back together.
      const now = new Date();
      const medicineLog = await tx.medicineLog.create({ data: { ...data,
        ...(doseId ? { id: doseId, createdAt: now, updatedAt: now } : {}),
      } });
      const currentMedicine = await references(tx);
      if (receiptWhere) await tx.externalImportRecord.create({ data: { ...receiptWhere, sourceChildId: body.babyId,
        targetEntityType: 'MedicineLog', targetRecordId: medicineLog.id, importedAt: medicineLog.updatedAt } });
      return { medicineLog, medicine: currentMedicine, created: true };
    }, serializable);
  } catch (error) {
    // Observe a concurrent winner only after our entire transaction rolled
    // back. Never retry the insert or replay a record without its receipt.
    if (identity && error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      try {
        const saved = await replay(db);
        if (saved) return { medicineLog: saved, medicine: await references(db), created: false };
      } catch (readError) { if (!contention(readError)) throw readError; }
      throw busy();
    }
    if (contention(error)) throw busy();
    throw error;
  }
}
