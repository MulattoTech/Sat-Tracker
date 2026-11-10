import { NextRequest, NextResponse } from 'next/server';
import { DiaperType, Gender, MeasurementType, MilestoneCategory, SleepQuality, SleepType } from '@prisma/client';
import type { Prisma } from '@prisma/client';

type FieldRule = {
  kind: 'string' | 'number' | 'boolean' | 'ids';
  nullable?: boolean;
  integer?: boolean;
  date?: boolean;
  nonempty?: boolean;
  choices?: readonly string[];
};
type FieldRules = Readonly<Record<string, FieldRule>>;

const text = { kind: 'string' } as const;
const nullableText = { ...text, nullable: true } as const;
export const careIdentifier = { ...text, nonempty: true } as const;
const date = { ...text, date: true } as const;
const number = { kind: 'number' } as const;
const boolean = { kind: 'boolean' } as const;
const contactIds = { kind: 'ids' } as const;
const choice = (values: Record<string, string>): FieldRule => ({ ...text, choices: Object.values(values) });

/** Only these API scalars may reach Prisma. Ownership and relation writes are server-built. */
export const careFields = {
  note: { babyId: careIdentifier, time: date, content: text, category: nullableText },
  sleep: {
    babyId: careIdentifier, startTime: date, endTime: { ...date, nullable: true },
    duration: { ...number, integer: true, nullable: true }, type: choice(SleepType),
    location: nullableText, quality: { ...choice(SleepQuality), nullable: true }, notes: nullableText,
  },
  bath: { babyId: careIdentifier, time: date, bathType: nullableText, soapUsed: boolean, shampooUsed: boolean, notes: nullableText },
  diaper: {
    babyId: careIdentifier, time: date, type: choice(DiaperType), condition: nullableText,
    color: nullableText, blowout: boolean, creamApplied: boolean, notes: nullableText,
  },
  medicineLog: { babyId: careIdentifier, medicineId: careIdentifier, time: date, doseAmount: number, unitAbbr: nullableText, notes: nullableText },
  measurement: { babyId: careIdentifier, date, type: choice(MeasurementType), value: number, unit: text, notes: nullableText },
  milestone: {
    babyId: careIdentifier, date, title: text, description: nullableText, category: choice(MilestoneCategory),
    ageInDays: { ...number, integer: true, nullable: true }, photo: nullableText,
  },
  vaccine: { babyId: careIdentifier, time: date, vaccineName: text, doseNumber: { ...number, integer: true, nullable: true }, notes: nullableText, contactIds },
  medicine: { name: text, typicalDoseSize: { ...number, nullable: true }, unitAbbr: nullableText, doseMinTime: nullableText, notes: nullableText, active: boolean, isSupplement: boolean, contactIds },
  baby: {
    firstName: text, lastName: text, birthDate: date, gender: { ...choice(Gender), nullable: true }, inactive: boolean,
    feedWarningTime: text, diaperWarningTime: text, feedTimerFrom: text, feedTimerTypes: nullableText,
  },
  adjustment: { babyId: careIdentifier, time: date, amount: number, unitAbbr: nullableText, reason: nullableText, notes: nullableText },
} satisfies Record<string, FieldRules>;

export class CareWriteError extends Error {
  constructor(message = 'Invalid care record fields.', readonly status = 400) { super(message); }
  response() { return NextResponse.json({ success: false, error: this.message }, { status: this.status }); }
}

function validScalar(value: unknown, rule: FieldRule): boolean {
  if (value === null) return rule.nullable === true;
  if (rule.kind === 'ids') return Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim().length > 0);
  if (typeof value !== rule.kind) return false;
  if (typeof value === 'number') return Number.isFinite(value) && (!rule.integer || Number.isSafeInteger(value));
  if (typeof value === 'string') {
    return (!rule.nonempty || value.trim().length > 0)
      && (!rule.date || Number.isFinite(Date.parse(value)))
      && (!rule.choices || rule.choices.includes(value));
  }
  return true;
}

/** Copy validated values into a new object; TypeScript request types alone do not filter JSON. */
export async function readCareWrite<T>(
  req: Pick<NextRequest, 'json'>,
  fields: FieldRules,
  required: readonly string[] = [],
  ignoredEchoes: FieldRules = {},
): Promise<T> {
  let input: unknown;
  try { input = await req.json(); } catch { throw new CareWriteError(); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CareWriteError();
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const writable = Object.hasOwn(fields, key);
    const rule = writable ? fields[key] : Object.hasOwn(ignoredEchoes, key) ? ignoredEchoes[key] : undefined;
    if (!rule || !validScalar(value, rule)) throw new CareWriteError();
    if (writable) data[key] = rule.kind === 'ids' ? [...new Set(value as string[])] : value;
  }
  if (required.some(key => !Object.hasOwn(data, key))) throw new CareWriteError();
  return data as T;
}

/** Validate relationship destinations before creating/replacing any associations. */
export async function requireCareContacts(
  db: Pick<Prisma.TransactionClient, 'contact'>,
  ids: readonly string[] | undefined,
  familyId: string,
  retainedIds: readonly string[] = [],
) {
  if (!ids?.length) return;
  // Existing same-family historical contacts may be retained. Only newly
  // selected associations require a live contact; family scope always applies.
  const availability = retainedIds.length
    ? { OR: [{ deletedAt: null }, { id: { in: [...retainedIds] } }] }
    : { deletedAt: null };
  const count = await db.contact.count({ where: { id: { in: [...ids] }, familyId, ...availability } });
  if (count !== ids.length) throw new CareWriteError('Contacts not found in this family.', 404);
}

export async function requireCareBaby(db: Pick<Prisma.TransactionClient, 'baby'>, babyId: string, familyId: string) {
  const baby = await db.baby.findFirst({ where: { id: babyId, familyId, deletedAt: null }, select: { id: true } });
  if (!baby) throw new CareWriteError('Baby not found in this family.', 404);
}
