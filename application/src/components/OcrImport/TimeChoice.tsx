import { resolveOcrLocalDateTime } from '@/src/lib/ocr/validation';
import { ChoiceField } from './Field';

interface Props {
  date: string | null;
  time: string | null;
  timeZone: string;
  value?: number;
  onChange: (value: number | undefined) => void;
  end?: boolean;
  disabled?: boolean;
}

export default function TimeChoice({ date, time, timeZone, value, onChange, end, disabled }: Props) {
  if (!date || !time) return null;
  const resolution = resolveOcrLocalDateTime(date, time, timeZone);
  if (resolution.status !== 'ambiguous') return null;
  const naive = Date.parse(`${date}T${time}:00Z`);
  const choices: [string, string][] = [['', 'Choose the intended clock occurrence']];
  for (const utc of resolution.candidates) {
    const offset = (naive - Date.parse(utc)) / 60000;
    const offsetLabel = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(utc));
    choices.push([String(offset), `${offsetLabel} · ${utc}`]);
  }
  return <ChoiceField label={end ? 'Repeated end time' : 'Repeated start time'} value={value === undefined ? '' : String(value)} choices={choices} disabled={disabled} onChange={selected => onChange(selected === '' ? undefined : Number(selected))} />;
}
