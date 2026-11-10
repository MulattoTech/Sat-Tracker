import { ExternalImportMedicineRecord, ExternalImportNoteRecord } from '@/src/types/external-import';
import { BabyBuddyCsvRow } from './parse';
import { parseBabyBuddyNumber } from './numbers';

function required(row: BabyBuddyCsvRow, field: string): string {
  const value = row[field]?.trim();
  if (!value) throw new Error(`Required field is missing: ${field}`);
  return value;
}

function toUtcInput(value: string): string {
  const source = value.trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(source)) {
    throw new Error(`Invalid Baby Buddy date-time: ${value}`);
  }
  return source.replace(' ', 'T');
}

const dosageUnits: Record<
  string,
  'MG' | 'ML' | 'TAB' | 'DROP'
> = {
  mg: 'MG',
  ml: 'ML',
  tablets: 'TAB',
  drops: 'DROP',
};

export function babyBuddyIntervalToDoseMinTime(
  value: string,
): string | undefined {
  const match = value
    .trim()
    .match(/^(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);

  if (!match) {
    return undefined;
  }

  let days = Number(match[1] || 0);
  let hours = Number(match[2]);
  const minutes = match[3];

  // Normalize: move excess hours into days
  days += Math.floor(hours / 24);
  hours %= 24;

  return `${String(days).padStart(2, '0')}:${String(hours).padStart(2, '0')}:${minutes}`;
}

export function mapBabyBuddyMedication(
  row: BabyBuddyCsvRow,
): ExternalImportMedicineRecord {
  const sourceChildId = required(row, 'child_id');
  const dosage = row.dosage?.trim();
  if (!dosage) throw new Error('Medication dose is missing. Preserve this source event as an unresolved note.');
  const unitAbbr =
    dosageUnits[row.dosage_unit?.trim().toLowerCase() ?? ''];
  const doseMinTime = babyBuddyIntervalToDoseMinTime(
    row.next_dose_interval ?? '',
  );

  return {
    targetType: 'medicine',
    source: {
      providerId: 'baby-buddy',
      entityType: 'medication',
      recordId: required(row, 'id'),
      childId: sourceChildId,
    },
    sourceChildId,
    time: toUtcInput(required(row, 'time')),
    medicineName: required(row, 'name'),
    doseAmount: parseBabyBuddyNumber(dosage, 'dosage'),
    ...(unitAbbr && { unitAbbr }),
    ...(doseMinTime && { doseMinTime }),
    notes: row.notes?.trim() || undefined,
  };
}

/** The canonical medicine log requires a numeric dose. An absent amount is not
 * zero: retain the source event as a clearly labelled note with its original
 * medication provenance until the source can be reconciled. */
export function mapBabyBuddyMedicationEntry(
  row: BabyBuddyCsvRow,
): ExternalImportMedicineRecord | ExternalImportNoteRecord {
  if (row.dosage?.trim()) return mapBabyBuddyMedication(row);
  const sourceChildId = required(row, 'child_id');
  const content = [
    `Medication: ${required(row, 'name')}`,
    'Dose amount: not recorded in the source. No numeric medicine dose was imported.',
    ...(row.dosage_unit?.trim() ? [`Source dose unit: ${row.dosage_unit.trim()}`] : []),
    ...(row.next_dose_interval?.trim() ? [`Source next-dose interval: ${row.next_dose_interval.trim()}`] : []),
    ...(row.notes?.trim() ? [`Source notes: ${row.notes.trim()}`] : []),
  ].join('\n');
  return {
    targetType: 'note',
    source: { providerId: 'baby-buddy', entityType: 'medication', recordId: required(row, 'id'), childId: sourceChildId },
    sourceChildId,
    time: toUtcInput(required(row, 'time')),
    content,
  };
}
