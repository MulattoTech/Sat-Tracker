import { FormEvent, useEffect, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { useLocalization } from '@/src/context/localization';
import { ChoiceField, Field, TextField } from './Field';

interface Props {
  babyName: string;
  defaultTimeZone: string;
  busy: string;
  onUpload: (form: FormData) => unknown;
  onCancel: () => void;
}

export default function UploadPanel({ babyName, defaultTimeZone, busy, onUpload, onCancel }: Props) {
  const { t } = useLocalization();
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState('');
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [timeFormat, setTimeFormat] = useState('unknown');
  const [rotation, setRotation] = useState('0');
  const [selectedPage, setSelectedPage] = useState('');
  const [crop, setCrop] = useState('');
  const [retention, setRetention] = useState('30');
  const [error, setError] = useState('');
  useEffect(() => { setTimeZone(current => current || defaultTimeZone); }, [defaultTimeZone]);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!file) { setError(t('Choose a photo or PDF first.')); return; }
    if (file.size > 12 * 1024 * 1024) { setError(t('Choose a document smaller than 12 MB.')); return; }
    const form = new FormData();
    form.set('file', file); form.set('timeZone', timeZone); form.set('timeFormat', timeFormat);
    form.set('rotation', rotation); form.set('retentionDays', retention);
    form.set('defaultDate', date);
    if (selectedPage.trim()) form.set('selectedPage', selectedPage.trim());
    if (crop.trim()) form.set('crop', crop.trim());
    onUpload(form);
  };
  return <form className="ocr-panel ocr-upload" onSubmit={submit}>
    <div className="ocr-panel-title"><UploadCloud aria-hidden="true" /><div><h2>{t('Bring a care log into your timeline')}</h2><p>{t('Import for')}: <strong>{babyName}</strong></p></div></div>
    <p className="ocr-muted">{t('Recognition runs on this server. English printed text is the current baseline; handwriting may need manual transcription. Every event needs your approval.')}</p>
    <Field label="Photo or document" hint="JPEG, PNG, WebP or PDF · up to 12 MB, all pages (up to 6) or single selected page (up to 100).">
      {id => <Input id={id} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={Boolean(busy)} onChange={event => setFile(event.target.files?.[0] ?? null)} />}
    </Field>
    <div className="ocr-field-grid">
      <TextField label="Date for rows without a date" type="date" value={date} onChange={setDate} disabled={Boolean(busy)} />
      <TextField label="Source time zone" value={timeZone} onChange={setTimeZone} placeholder="America/Chicago" disabled={Boolean(busy)} />
      <ChoiceField label="Clock format on this sheet" value={timeFormat} onChange={setTimeFormat} disabled={Boolean(busy)} choices={[
        ['unknown', 'Unspecified — flag ambiguous times'], ['24h', '24-hour clock'], ['12h', '12-hour clock with AM/PM'],
      ]} />
      <ChoiceField label="Rotate before recognition" value={rotation} onChange={setRotation} disabled={Boolean(busy)} choices={[
        ['0', 'No extra rotation'], ['90', '90° clockwise'], ['180', '180°'], ['270', '90° counterclockwise'],
      ]} />
      <TextField label="PDF page number (optional)" type="number" min={1} max={100} value={selectedPage} onChange={setSelectedPage} placeholder="Leave blank for all pages" disabled={Boolean(busy)} />
      <TextField label="Crop box (optional)" value={crop} onChange={setCrop} placeholder="e.g. 10%, 10%, 80%, 80% or left,top,w,h" disabled={Boolean(busy)} />
      <TextField label="Keep original source for days" type="number" min={1} max={365} step={1} value={retention} onChange={setRetention} disabled={Boolean(busy)} />
    </div>
    <p className="ocr-hint">{t('A blank date stays unresolved. Confirm the time zone written on the log; it may differ from your device. Source files can be removed after review without deleting care events.')}</p>
    {error && <p role="alert" className="ocr-error">{error}</p>}
    <div className="ocr-button-row">
      <Button type="submit" disabled={!file || Boolean(busy)}>{busy === 'upload' ? t('Recognizing document…') : t('Upload and create review draft')}</Button>
      {busy === 'upload' && <Button type="button" variant="outline" onClick={onCancel}>{t('Cancel recognition')}</Button>}
    </div>
  </form>;
}
