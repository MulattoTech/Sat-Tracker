import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/src/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { useLocalization } from '@/src/context/localization';
import { useTimezone } from '@/app/context/timezone';
import { FilterType } from './full-log-timeline.types';
import './activity-pdf.css';

interface FullLogExportButtonProps {
  babyId: string;
  startDate: Date;
  endDate: Date;
  activeFilter: FilterType;
}

const FullLogExportButton: React.FC<FullLogExportButtonProps> = ({
  babyId,
  startDate,
  endDate,
  activeFilter,
}) => {
  const { t, language } = useLocalization();
  const { userTimezone } = useTimezone();
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [preparingPdf, setPreparingPdf] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setIsOpen(false);
    setIsExporting(true);
    setExportError(null);
    setPreparingPdf(format === 'pdf');

    try {
      const adjustedStart = new Date(startDate);
      adjustedStart.setHours(0, 0, 0, 0);
      const adjustedEnd = new Date(endDate);
      adjustedEnd.setHours(23, 59, 59, 999);

      const params = new URLSearchParams({
        babyId,
        startDate: adjustedStart.toISOString(),
        endDate: adjustedEnd.toISOString(),
        format: format === 'pdf' ? 'json' : format,
        timezone: userTimezone,
        language: language || 'en',
      });

      if (activeFilter) {
        params.set('filter', activeFilter);
      }

      const authToken = localStorage.getItem('authToken');
      const response = await fetch(`/api/timeline/export?${params.toString()}`, {
        headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
      });

      if (!response.ok) {
        setExportError(t('Unable to export activities. Please try again.'));
        return;
      }

      if (format === 'pdf') {
        const result = await response.json();
        if (!result.success || !Array.isArray(result.data?.rows)) throw new Error('Invalid export response');
        const { downloadActivityPdf } = await import('./activity-pdf');
        const dateOptions: Intl.DateTimeFormatOptions = { timeZone: userTimezone, dateStyle: 'medium' };
        await downloadActivityPdf({ ...result.data, title: t('Activity Log'), timezone: userTimezone,
          language: language || 'en', range: `${adjustedStart.toLocaleDateString(language || 'en', dateOptions)} – ${adjustedEnd.toLocaleDateString(language || 'en', dateOptions)}` });
        return;
      }

      // Download the file
      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition');
      const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
      const filename = filenameMatch?.[1] || `activity-log.${format}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setExportError(t('Unable to export activities. Please try again.'));
    } finally {
      setIsExporting(false);
      setPreparingPdf(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isExporting}
        className="flex items-center gap-1 h-7 text-sm font-medium text-white hover:bg-transparent hover:text-white/90 p-0"
      >
        {isExporting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        {preparingPdf ? t('Preparing PDF...') : t('Export')}
      </Button>

      {exportError && <p role="alert" className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md bg-white p-3 text-sm text-red-700 shadow-lg">{exportError}</p>}

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[140px]">
          <button
            onClick={() => handleExport('csv')}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {t('Export CSV')}
          </button>
          <button
            onClick={() => handleExport('xlsx')}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {t('Export XLSX')}
          </button>
          <button
            onClick={() => handleExport('pdf')}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            {t('Export PDF')}
          </button>
        </div>
      )}
    </div>
  );
};

export default FullLogExportButton;
