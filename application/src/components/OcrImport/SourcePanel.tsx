import { useEffect, useState } from 'react';
import { Download, FileText, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import type { OcrDocumentView } from '@/src/lib/ocr/contracts';
import { useLocalization } from '@/src/context/localization';
import { ocrSource } from './api';
import { ChoiceField } from './Field';

interface Props {
  document: OcrDocumentView;
  page: number;
  onPage: (page: number) => void;
  busy: boolean;
  onPurge: () => void;
}

export default function SourcePanel({ document, page, onPage, busy, onPurge }: Props) {
  const { t } = useLocalization();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = '';
    setUrl(''); setError(''); setLoading(document.hasSource);
    if (document.hasSource) ocrSource(document.id, page, abort.signal)
      .then(blob => { if (!abort.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(reason => { if (!abort.signal.aborted) setError(reason.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [document.id, document.hasSource, page]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const blob = await ocrSource(document.id);
      const objectUrl = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = objectUrl; link.download = document.originalName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('Download failed.')); }
    finally { setDownloading(false); }
  };
  const availablePages = document.pages && document.pages.length > 0
    ? document.pages
    : Array.from({ length: document.pageCount }, (_, index) => index + 1);

  return <section className="ocr-panel ocr-source" aria-label={t('Original source')}>
    <div className="ocr-panel-title"><FileText aria-hidden="true" /><div><h2>{t('Original source')}</h2><p className="ocr-filename">{document.originalName}</p></div></div>
    <div className="ocr-source-controls">
      <ChoiceField label="Source page" value={String(page)} onChange={value => onPage(Number(value))} choices={availablePages.map(p => [String(p), `${t('Page')} ${p}`] as const)} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setZoom(value => !value)}
        aria-pressed={zoom}
        aria-label={t(zoom ? 'Fit page' : 'Enlarge')}
        disabled={!url}
      >
        {zoom ? <ZoomOut aria-hidden="true" size={16} /> : <ZoomIn aria-hidden="true" size={16} />}{zoom ? t('Fit page') : t('Enlarge')}
      </Button>
    </div>
    {loading && <p role="status" className="ocr-muted">{t('Loading private source preview…')}</p>}
    {error && <p role="alert" className="ocr-error">{t(error)}</p>}
    {!document.hasSource && <p className="ocr-notice">{t('The source files were removed or expired. Review history and imported care events remain available.')}</p>}
    {url && <div
      className={`ocr-source-image${zoom ? ' ocr-source-zoom' : ''}`}
      tabIndex={0}
      role="region"
      aria-label={t('Scrollable source preview')}
      onKeyDown={e => {
        if (e.key === '+' || e.key === '=') { setZoom(true); e.preventDefault(); }
        else if (e.key === '-') { setZoom(false); e.preventDefault(); }
      }}
    >
      {/* Authorized blob URLs avoid putting credentials or private document URLs in image requests. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={`${t('Source page')} ${page} — ${document.originalName}`} />
    </div>}
    <p className="ocr-hint">{t('Source retention ends')}: {new Date(document.sourceExpiresAt).toLocaleString()}</p>
    {document.hasSource && <div className="ocr-button-row">
      <Button type="button" variant="outline" size="sm" onClick={download} disabled={downloading || busy}><Download size={15} aria-hidden="true" />{t('Download original')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onPurge} disabled={busy}>{t('Remove source files')}</Button>
    </div>}
  </section>;
}
