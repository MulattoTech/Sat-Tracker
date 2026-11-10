import { AlertCircle, AlertTriangle, Ban, CheckCircle2, CopyPlus, FileSearch, GitMerge, RotateCcw, Trash2, XCircle } from 'lucide-react';
import type { OcrCandidate, OcrEditableField, OcrFieldOrigin } from '@/src/lib/ocr/types';
import { normalizeAmountMl } from '@/src/lib/ocr/validation';
import { Button } from '@/src/components/ui/button';
import { Textarea } from '@/src/components/ui/textarea';
import { useLocalization } from '@/src/context/localization';
import { ChoiceField, Field, TextField } from './Field';
import { RowOffsets, rowReviewIssues } from './review-helpers';
import TimeChoice from './TimeChoice';

interface Props {
  row: OcrCandidate;
  number: number;
  timeZone: string;
  offsets?: RowOffsets;
  locked: boolean;
  isDuplicate?: boolean;
  duplicateDecision?: 'skip' | 'keep';
  canMergePrevious?: boolean;
  canMergeNext?: boolean;
  onEdit: (patch: Partial<OcrCandidate>) => void;
  onApprove: (value: boolean) => void;
  onReject?: (rejected: boolean) => void;
  onOffset: (key: 'start' | 'end', value: number | undefined) => void;
  onSource: () => void;
  onSplit: () => void;
  onMergePrevious?: () => void;
  onMergeNext?: () => void;
  onRemove: () => void;
}

const fieldLabels: Record<OcrEditableField, string> = {
  eventType: 'Event type', localDate: 'Event date', localTime: 'Event time', endLocalDate: 'Sleep end date',
  endLocalTime: 'Sleep end time', feedType: 'Feeding method', bottleType: 'Milk designation', amount: 'Feeding amount',
  unit: 'Amount unit', diaperType: 'Diaper type', sleepType: 'Sleep type', notes: 'Notes',
  feedDuration: 'Feeding duration (minutes)', offeredAmount: 'Volume offered (same unit)', formulaKcalOz: 'Formula concentration (kcal/oz)',
  formulaName: 'Formula name', bottleLabel: 'Bottle identifier', sourceCaregiverName: 'Source caregiver name',
};
const originLabels: Record<OcrFieldOrigin, string> = {
  source: 'Recognized from source', context: 'Date or sheet context', missing: 'Not recorded',
  ambiguous: 'Needs clarification', corrected: 'Corrected during review',
};

export default function RowEditor({
  row, number, timeZone, offsets, locked, isDuplicate, duplicateDecision,
  canMergePrevious, canMergeNext, onEdit, onApprove, onReject, onOffset,
  onSource, onSplit, onMergePrevious, onMergeNext, onRemove,
}: Props) {
  const { t } = useLocalization();
  const issues = rowReviewIssues(row, timeZone, offsets);
  const warnings = [...new Set([...row.warnings, ...issues.warnings])];
  const change = <K extends keyof OcrCandidate,>(key: K, value: OcrCandidate[K]) => onEdit({ [key]: value });
  const isRejected = Boolean(row.rejected);
  const status = isRejected ? 'Rejected' : row.approved ? 'Approved for import' : issues.errors.length ? 'Needs correction' : 'Ready for review';

  return <article
    className={`ocr-row${row.approved ? ' ocr-row-approved' : ''}${isRejected ? ' ocr-row-rejected' : ''}`}
    aria-label={`${t('Draft event')} ${number}`}
    tabIndex={-1}
  >
    <header className="ocr-row-header">
      <div>
        <span className="ocr-row-number">{number}</span>
        <strong>{t('Draft event')}</strong>
        <span className={`ocr-status ${isRejected ? 'ocr-status-rejected' : row.approved ? 'ocr-status-ok' : issues.errors.length ? 'ocr-status-review' : 'ocr-status-ready'}`} role="status">
          {isRejected && <XCircle size={13} aria-hidden="true" />}
          {!isRejected && row.approved && <CheckCircle2 size={13} aria-hidden="true" />}
          {!isRejected && !row.approved && issues.errors.length > 0 && <AlertCircle size={13} aria-hidden="true" />}
          {t(status)}
        </span>
        {isDuplicate && <span className="ocr-status ocr-status-duplicate" role="status" aria-label={t('Duplicate alert')}>
          <AlertTriangle size={13} aria-hidden="true" />
          {t(duplicateDecision === 'keep' ? 'Separate event (Keep)' : duplicateDecision === 'skip' ? 'Duplicate (Skip)' : 'Possible duplicate')}
        </span>}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onSource} aria-label={`${t('View source on page')} ${row.source.page}`}>
        <FileSearch size={15} aria-hidden="true" />{t('Page')} {row.source.page}
      </Button>
    </header>

    {isRejected && <div className="ocr-row-rejected-banner" role="status">
      <p>{t('This draft event is marked as rejected. It will be excluded from the import.')}</p>
      {!locked && onReject && <Button type="button" size="sm" variant="outline" onClick={() => onReject(false)}>
        <RotateCcw size={14} aria-hidden="true" />{t('Restore to review')}
      </Button>}
    </div>}

    <fieldset disabled={locked || isRejected} className="ocr-row-fields">
      <legend className="sr-only">{t('Correct this event')}</legend>
      <div className="ocr-field-grid">
        <ChoiceField label="Event type" value={row.eventType} onChange={value => change('eventType', value as OcrCandidate['eventType'])} choices={[
          ['unknown', 'Choose event type'], ['feed', 'Feeding'], ['diaper', 'Diaper'], ['sleep', 'Sleep'],
        ]} />
        <TextField label="Event date" type="date" value={row.localDate ?? ''} onChange={value => change('localDate', value || null)} />
        <TextField label="Event time (24-hour)" type="time" value={row.localTime ?? ''} onChange={value => change('localTime', value || null)} />
        <TimeChoice date={row.localDate} time={row.localTime} timeZone={timeZone} value={offsets?.start} onChange={value => onOffset('start', value)} />
        {row.eventType === 'feed' && <>
          <ChoiceField label="Feeding method" value={row.feedType ?? ''} onChange={value => change('feedType', value as OcrCandidate['feedType'] || null)} choices={[
            ['', 'Choose feeding method'], ['BOTTLE', 'Bottle'], ['BREAST', 'Breastfeeding'],
          ]} />
          <ChoiceField label="Milk designation" value={row.bottleType ?? ''} onChange={value => change('bottleType', value as OcrCandidate['bottleType'] || null)} choices={[
            ['', 'Not recorded'], ['Formula', 'Formula'], ['Breast Milk', 'Breast milk'], ['Other', 'Other — describe in notes'],
          ]} />
          <TextField label="Feeding amount" type="number" min={0} step="any" value={row.amount === null ? '' : String(row.amount)} onChange={value => change('amount', value === '' ? null : Number(value))} />
          <ChoiceField label="Amount unit" value={row.unit ?? ''} onChange={value => change('unit', value as OcrCandidate['unit'] || null)} choices={[
            ['', 'Choose unit'], ['ML', 'mL'], ['OZ', 'US fluid ounces'],
          ]} />
          <TextField label="Feeding duration (minutes)" type="number" min={1 / 60} max={1440} step="any" value={row.feedDuration == null ? '' : String(row.feedDuration / 60)} onChange={value => change('feedDuration', value === '' ? null : Math.round(Number(value) * 60))} />
          <TextField label="Volume offered (same unit)" type="number" min={0} step="any" value={row.offeredAmount == null ? '' : String(row.offeredAmount)} onChange={value => change('offeredAmount', value === '' ? null : Number(value))} />
          <TextField label="Formula concentration (kcal/oz)" type="number" min={0} step="any" value={row.formulaKcalOz == null ? '' : String(row.formulaKcalOz)} onChange={value => change('formulaKcalOz', value === '' ? null : Number(value))} />
          <TextField label="Formula name" value={row.formulaName ?? ''} onChange={value => change('formulaName', value || null)} />
          <TextField label="Bottle identifier" value={row.bottleLabel ?? ''} onChange={value => change('bottleLabel', value || null)} />
          <TextField label="Source caregiver name" value={row.sourceCaregiverName ?? ''} onChange={value => change('sourceCaregiverName', value || null)} />
        </>}
        {row.eventType === 'diaper' && <ChoiceField label="Diaper type" value={row.diaperType ?? ''} onChange={value => change('diaperType', value as OcrCandidate['diaperType'] || null)} choices={[
          ['', 'Choose diaper type'], ['WET', 'Wet'], ['DIRTY', 'Dirty'], ['BOTH', 'Wet and dirty'], ['DRY', 'Dry'],
        ]} />}
        {row.eventType === 'sleep' && <>
          <ChoiceField label="Sleep type" value={row.sleepType ?? ''} onChange={value => change('sleepType', value as OcrCandidate['sleepType'] || null)} choices={[
            ['', 'Choose sleep type'], ['NAP', 'Nap'], ['NIGHT_SLEEP', 'Night sleep'],
          ]} />
          <TextField label="Sleep end date" type="date" value={row.endLocalDate ?? ''} onChange={value => change('endLocalDate', value || null)} />
          <TextField label="Sleep end time (24-hour)" type="time" value={row.endLocalTime ?? ''} onChange={value => change('endLocalTime', value || null)} />
          <TimeChoice date={row.endLocalDate} time={row.endLocalTime} timeZone={timeZone} value={offsets?.end} onChange={value => onOffset('end', value)} end />
        </>}
      </div>
      {row.eventType === 'feed' && <p className="ocr-hint">{t('Feeding amount is consumed volume. Leave unrecorded details blank. Source caregiver is a label, not an account assignment.')}</p>}
      {row.eventType === 'feed' && row.amount !== null && Number.isFinite(row.amount) && row.amount > 0 && row.unit && <p className="ocr-hint">{t('Equivalent volume')}: {normalizeAmountMl(row.amount, row.unit)} mL · {t('The entered unit is preserved.')}</p>}
      <Field label="Notes and stool characteristics">{id => <Textarea id={id} value={row.notes} maxLength={2000} rows={2} onChange={event => change('notes', event.target.value)} />}</Field>
      {!isRejected && issues.errors.length > 0 && <ul className="ocr-row-errors" aria-label={t('Fields to resolve')}>{issues.errors.map(message => <li key={message}>{t(message)}</li>)}</ul>}
      {!isRejected && <label className="ocr-approval">
        <input type="checkbox" checked={row.approved} disabled={locked || (!row.approved && issues.errors.length > 0)} onChange={event => onApprove(event.target.checked)} />
        <span>{t('I checked this event against the source. Include it in the import.')}</span>
      </label>}
    </fieldset>

    <details className="ocr-evidence">
      <summary>{t('Recognized text, uncertainty and provenance')}</summary>
      <p className="ocr-hint">{t('Source page')}: {row.source.page} · {t('Line')}: {row.source.line} · {t('Engine')}: {row.source.engine}</p>
      <p className="ocr-hint">{t('Engine recognition score')}: {row.source.confidence === null ? t('Unavailable') : `${row.source.confidence.toFixed(1)} / 100`} · {t('This is not a field accuracy score.')}</p>
      <pre className="ocr-raw-text">{row.source.rawText || t('Manual transcription — compare with the original page.')}</pre>
      {warnings.length > 0 && <ul className="ocr-warnings">{warnings.map(message => <li key={message}>{t(message)}</li>)}</ul>}
      <dl className="ocr-provenance">{Object.entries(row.fieldSources).map(([field, origin]) => <div key={field}><dt>{t(fieldLabels[field as OcrEditableField] || field)}</dt><dd>{t(originLabels[origin] || origin)}</dd></div>)}</dl>
    </details>

    {!locked && <div className="ocr-button-row ocr-row-tools">
      <Button type="button" size="sm" variant="outline" onClick={onSplit} aria-label={`${t('Split event')} ${number} ${t('into another draft row')}`}>
        <CopyPlus size={14} aria-hidden="true" />{t('Split into another draft row')}
      </Button>
      {canMergePrevious && onMergePrevious && <Button type="button" size="sm" variant="outline" onClick={onMergePrevious} aria-label={`${t('Merge event')} ${number} ${t('with previous event')} ${number - 1}`}>
        <GitMerge size={14} aria-hidden="true" />{t('Merge with previous')}
      </Button>}
      {canMergeNext && onMergeNext && <Button type="button" size="sm" variant="outline" onClick={onMergeNext} aria-label={`${t('Merge event')} ${number} ${t('with next event')} ${number + 1}`}>
        <GitMerge size={14} aria-hidden="true" />{t('Merge with next')}
      </Button>}
      {onReject && (isRejected ? <Button type="button" size="sm" variant="outline" onClick={() => onReject(false)} aria-label={`${t('Restore event')} ${number} ${t('to review')}`}>
        <RotateCcw size={14} aria-hidden="true" />{t('Restore to review')}
      </Button> : <Button type="button" size="sm" variant="outline" onClick={() => onReject(true)} aria-label={`${t('Reject event')} ${number}`}>
        <Ban size={14} aria-hidden="true" />{t('Reject draft row')}
      </Button>)}
      <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={`${t('Remove draft row')} ${number}`}>
        <Trash2 size={14} aria-hidden="true" />{t('Remove draft row')}
      </Button>
    </div>}
  </article>;
}
