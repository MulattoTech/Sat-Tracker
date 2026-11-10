import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { formatInTimeZone } from 'date-fns-tz';
import { bottleInput, JournalError, localTimeToInstant, object, text, timeZone } from './validation';

export interface LegacyBottle {
  sourceId: string; localTime: string; time: string; amount: number | null;
  unitAbbr: 'ML'; bottleType: string; offeredAmount: number | null;
  formulaKcalOz: number | null; formulaName: string | null; bottleLabel: string | null;
  sourceCaregiverName: string | null; notes: string | null; issue: string | null;
}
export function parseLegacyJournal(content: string, format: string, zone: string): { rows: LegacyBottle[]; warnings: string[]; targetMl: number | null } {
  timeZone(zone);
  if (Buffer.byteLength(content, 'utf8') > 1_500_000) throw new JournalError('Choose a journal export smaller than 1.5 MB.');
  let source: Record<string, unknown>[]; const warnings: string[] = []; let targetMl: number | null = null;
  if (format === 'json') {
    let parsed: Record<string, unknown>;
    try { parsed = object(JSON.parse(content)); } catch { throw new JournalError('Choose a valid Family Bottle Journal JSON backup.'); }
    if (![1, 2].includes(parsed.version as number) || !Array.isArray(parsed.feedings)) throw new JournalError('Choose a Family Bottle Journal version 1 or 2 backup.');
    source = parsed.feedings.map(object).filter(row => !row.deleted_at_ms);
    if (Array.isArray(parsed.pending_changes) && parsed.pending_changes.length) warnings.push('This backup contains pending changes. Resolve them in the original journal before migrating; only confirmed bottles are shown.');
    if (Array.isArray(parsed.unresolved_conflicts) && parsed.unresolved_conflicts.length) warnings.push('Unresolved conflicts were preserved in the original backup and are not imported.');
    if (parsed.settings && typeof parsed.settings === 'object') {
      const goal = (parsed.settings as Record<string, unknown>).daily_goal_ml;
      if (typeof goal === 'number' && goal > 0 && goal <= 10_000) targetMl = goal;
    }
  } else if (format === 'csv') {
    let rows: Record<string, string>[];
    try { rows = parse(content, { columns: true, bom: true, skip_empty_lines: true, max_record_size: 16000 }); }
    catch { throw new JournalError('The journal CSV could not be read.'); }
    if (rows.length && !['Date', 'Time', 'Consumed (mL)', 'Formula (kcal/fl oz)'].every(key => key in rows[0])) throw new JournalError('Choose a CSV exported by Family Bottle Journal.');
    const occurrences = new Map<string, number>();
    source = rows.map(row => {
      const hash = createHash('sha256').update(JSON.stringify(['Date','Time','Consumed (mL)','Formula (kcal/fl oz)','Notes','Recorded by'].map(key => row[key] || ''))).digest('hex');
      const occurrence = occurrences.get(hash) || 0; occurrences.set(hash, occurrence + 1);
      return { id: `csv-${hash}-${occurrence}`, feed_date: row.Date, feed_time: row.Time || null,
        volume_ml: row['Consumed (mL)'] === '' ? null : Number(row['Consumed (mL)']),
        formula_kcal_oz: row['Formula (kcal/fl oz)'] === '' ? null : Number(row['Formula (kcal/fl oz)']),
        notes: row.Notes, created_by: row['Recorded by'], pending: row['Sync status']?.startsWith('Pending') };
    });
    if (source.some(row => row.pending)) warnings.push('Some CSV entries were pending on the original device. Review them before importing.');
    warnings.push('CSV has no original record IDs. Exact repeat files are deduplicated; matching existing bottles require an explicit decision.');
  } else throw new JournalError('Choose a JSON backup or CSV export.');
  if (source.length > 500) throw new JournalError('Review at most 500 bottles per import. Split a larger export into smaller files.');
  const ids = new Set<string>();
  const rows = source.map(row => {
    const id = text(row.id, 100, 'source bottle ID')!;
    if (ids.has(id)) throw new JournalError('The backup contains repeated bottle IDs. Resolve them in the original journal.');
    ids.add(id);
    let time = '', localTime = '', issue: string | null = null;
    try {
      if (typeof row.fed_at_ms === 'number' && Number.isFinite(row.fed_at_ms)) {
        time = new Date(row.fed_at_ms).toISOString(); localTime = formatInTimeZone(time, zone, "yyyy-MM-dd'T'HH:mm");
      } else if (typeof row.feed_date === 'string' && typeof row.feed_time === 'string' && row.feed_time) {
        localTime = row.feed_date + 'T' + row.feed_time; time = localTimeToInstant(localTime, zone);
      } else { localTime = typeof row.feed_date === 'string' ? row.feed_date + 'T' : ''; issue = 'The original time is unknown. Enter a verified time or leave this row unselected.'; }
    } catch (error) { issue = error instanceof JournalError ? error.message : 'The original time is invalid. Correct it before importing.'; }
    const result: LegacyBottle = { sourceId: id, time, localTime, amount: typeof row.volume_ml === 'number' ? row.volume_ml : null,
      unitAbbr: 'ML', bottleType: typeof row.formula_kcal_oz === 'number' ? 'Formula' : 'Other', offeredAmount: null, formulaKcalOz: typeof row.formula_kcal_oz === 'number' ? row.formula_kcal_oz : null,
      formulaName: null, bottleLabel: null, sourceCaregiverName: text(row.created_by, 120, 'original caregiver', true),
      notes: text(row.notes, 2000, 'notes', true), issue };
    if (!issue) { try { bottleInput(result); } catch (error) { result.issue = error instanceof JournalError ? error.message : 'Correct this bottle before importing.'; } }
    return result;
  });
  return { rows, warnings, targetMl };
}
