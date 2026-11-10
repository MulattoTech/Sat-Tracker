import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { convertVolume, normalizeVolumeUnit } from '@/src/utils/unit-conversion';

export class JournalError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JournalError('A journal object is required.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, label: string, optional = false): string | null {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || value.length > max || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new JournalError(`Invalid ${label}.`);
  return value.trim();
}
export function number(value: unknown, max: number, label: string, optional = false): number | null {
  if (optional && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new JournalError(`Invalid ${label}.`);
  return value;
}
export function timeZone(value: unknown): string {
  const zone = text(value, 100, 'time zone')!;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { throw new JournalError('Choose a valid time zone.'); }
  return zone;
}
export function calendarDay(value: unknown): string {
  const day = text(value, 10, 'date')!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new JournalError('Choose a valid date.');
  return day;
}
export function journalWindow(day: string, zone: string, now = new Date()) {
  calendarDay(day); timeZone(zone);
  const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { dayStart: fromZonedTime(`${day}T00:00:00`, zone), dayEnd: fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, zone), rollingStart: new Date(now.getTime() - 86_400_000), now };
}
export function localTimeToInstant(value: unknown, zone: string): string {
  const local = text(value, 19, 'feeding date and time')!;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) throw new JournalError('Enter a complete feeding date and time.');
  const instant = fromZonedTime(local, timeZone(zone));
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, zone, "yyyy-MM-dd'T'HH:mm") !== local.slice(0,16)) throw new JournalError('That local time does not exist. Check the date and daylight saving change.');
  // A repeated wall-clock time must be resolved explicitly with an offset.
  for (const minutes of [-120, -60, -30, 30, 60, 120]) {
    if (formatInTimeZone(new Date(instant.getTime() + minutes * 60_000), zone, "yyyy-MM-dd'T'HH:mm") === local.slice(0,16)) throw new JournalError('That time occurs twice during the daylight saving change. Use an ISO time with its UTC offset.');
  }
  return instant.toISOString();
}

export interface BottleInput {
  time: Date; type: 'BOTTLE'; amount: number; offeredAmount: number | null;
  unitAbbr: 'ML' | 'OZ'; bottleType: string; formulaKcalOz: number | null;
  formulaName: string | null; bottleLabel: string | null; notes: string | null;
  sourceCaregiverName: string | null;
}
export function bottleInput(value: unknown, now = new Date()): BottleInput {
  const body = object(value);
  const instant = text(body.time, 40, 'feeding time')!;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(instant)) throw new JournalError('A feeding time with a UTC offset is required.');
  calendarDay(instant.slice(0, 10));
  const time = new Date(instant);
  if (!Number.isFinite(time.getTime()) || time > new Date(now.getTime() + 300_000)) throw new JournalError('Choose a valid feeding time that is not in the future.');
  const unitAbbr = normalizeVolumeUnit(typeof body.unitAbbr === 'string' ? body.unitAbbr : 'invalid');
  if (!unitAbbr) throw new JournalError('Choose mL or oz.');
  const amount = number(body.amount, unitAbbr === 'ML' ? 2000 : 68, 'consumed volume')!;
  const offeredAmount = number(body.offeredAmount, unitAbbr === 'ML' ? 2000 : 68, 'offered volume', true);
  if (offeredAmount !== null && offeredAmount < amount) throw new JournalError('Consumed volume cannot exceed offered volume.');
  const bottleType = text(body.bottleType, 30, 'milk type')!;
  if (!['Formula', 'Breast Milk', 'Formula/Breast', 'Other'].includes(bottleType)) throw new JournalError('Choose a milk type.');
  const formulaKcalOz = number(body.formulaKcalOz, 60, 'formula concentration', true);
  if (formulaKcalOz === 0) throw new JournalError('Formula concentration must be positive or left blank.');
  return { time, type: 'BOTTLE', amount, offeredAmount, unitAbbr, bottleType, formulaKcalOz,
    formulaName: text(body.formulaName, 120, 'formula name', true), bottleLabel: text(body.bottleLabel, 80, 'bottle label', true),
    notes: text(body.notes, 2000, 'notes', true), sourceCaregiverName: text(body.sourceCaregiverName, 120, 'original caregiver', true) };
}

export interface BottleLike { time: Date | string; type?: string; amount?: number | null; unitAbbr?: string | null; deletedAt?: Date | string | null }
/** Validate the additive journal fields when the older feeding form edits a record. */
export function validateBottleMetadata(body: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  const amount = body.amount === undefined ? previous.amount : body.amount;
  const offered = body.offeredAmount === undefined ? previous.offeredAmount : body.offeredAmount;
  if (offered != null) {
    number(offered, 2000, 'offered volume');
    if (amount != null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > (offered as number))) throw new JournalError('Consumed volume cannot exceed offered volume.');
    if (previous.offeredAmount != null && body.unitAbbr !== undefined && normalizeVolumeUnit(body.unitAbbr as string) !== normalizeVolumeUnit(previous.unitAbbr as string) && body.offeredAmount === undefined) throw new JournalError('Use Bottle Journal to convert both offered and consumed volume.');
  }
  if (body.formulaKcalOz !== undefined) { const kcal = number(body.formulaKcalOz, 60, 'formula concentration', true); if (kcal === 0) throw new JournalError('Formula concentration must be positive or left blank.'); }
  if (body.formulaName !== undefined) text(body.formulaName, 120, 'formula name', true);
  if (body.bottleLabel !== undefined) text(body.bottleLabel, 80, 'bottle label', true);
}
export function journalTotals(rows: readonly BottleLike[], bounds: ReturnType<typeof journalWindow>, target: number | null) {
  let dailyMl = 0, rollingMl = 0, dailyCount = 0, rollingCount = 0, unknownVolumes = 0;
  for (const row of rows) {
    if (row.type !== 'BOTTLE' || row.deletedAt) continue;
    const time = new Date(row.time), unit = normalizeVolumeUnit(row.unitAbbr);
    if (time > bounds.now || !Number.isFinite(time.getTime())) continue;
    const daily = time >= bounds.dayStart && time < bounds.dayEnd;
    const rolling = time >= bounds.rollingStart && time <= bounds.now;
    if (!daily && !rolling) continue;
    if (daily) dailyCount++; if (rolling) rollingCount++;
    if (!unit || row.amount == null || !Number.isFinite(row.amount) || row.amount < 0) { unknownVolumes++; continue; }
    const ml = convertVolume(row.amount, unit, 'ML');
    if (daily) dailyMl += ml; if (rolling) rollingMl += ml;
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return { dailyMl: round(dailyMl), rollingMl: round(rollingMl), dailyCount, rollingCount, unknownVolumes,
    targetMl: target, remainingMl: target == null ? null : round(Math.max(0, target - dailyMl)),
    progress: target ? Math.round(dailyMl / target * 100) : null };
}
