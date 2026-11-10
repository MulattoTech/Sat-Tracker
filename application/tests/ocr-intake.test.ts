import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { jsPDF } from 'jspdf';
import {
  acquireOcrSlot, identifyOcrUpload, readTesseractTsv, recognizeOcrDocument,
  parseOcrCrop, validateOcrCrop, applyImageTransform, OCR_LIMITS,
  usableNativePdfText, pdfPageHasRasterContent,
} from '@/src/lib/ocr/intake';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { openOcrState, sealOcrState } from '@/src/lib/ocr/crypto';
import { validateOcrCandidate } from '@/src/lib/ocr/validation';
import type { OcrCandidate } from '@/src/lib/ocr/types';

export async function syntheticCareImage(): Promise<Buffer> {
  return sharp(Buffer.from('<svg width="1800" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="52"><text x="70" y="120">2026-10-20</text><text x="70" y="240">08:15 bottle formula 90 mL</text><text x="70" y="360">09:30 wet diaper</text><text x="70" y="480">14:00 bottle breast milk 3 oz</text></g></svg>')).png().toBuffer();
}

describe('bounded local OCR intake', () => {
  it('sniffs content, rejects unsupported formats and enforces byte limits', () => {
    expect(identifyOcrUpload(Buffer.from('%PDF-1.4\n'))).toBe('application/pdf');
    expect(identifyOcrUpload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))).toBe('image/png');
    expect(identifyOcrUpload(Buffer.from([255, 216, 255, 0]))).toBe('image/jpeg');
    expect(identifyOcrUpload(Buffer.from('RIFF1234WEBP'))).toBe('image/webp');
    expect(() => identifyOcrUpload(Buffer.from('<script>alert(1)</script>'))).toThrow('Supported');
    expect(() => identifyOcrUpload(Buffer.alloc(OCR_LIMITS.bytes + 1))).toThrow('12 MB');
  });

  it('does not equate engine confidence with field accuracy', () => {
    const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t1\t1\t1\t1\t93\t08:15\n5\t1\t1\t1\t1\t2\t1\t1\t1\t1\t91\tbottle';
    expect(readTesseractTsv(tsv)).toEqual({ text: '08:15 bottle', confidence: 92 });
  });

  it('bounds concurrent jobs and releases the slot', () => {
    const releaseA = acquireOcrSlot('synthetic-a');
    expect(() => acquireOcrSlot('synthetic-a')).toThrow('busy');
    const releaseB = acquireOcrSlot('synthetic-b');
    expect(() => acquireOcrSlot('synthetic-c')).toThrow('busy');
    releaseA(); releaseB(); acquireOcrSlot('synthetic-c')();
  });

  it('parses and validates crop specifications in pixel and percentage forms', () => {
    expect(parseOcrCrop('100, 200, 800, 600')).toEqual({ left: 100, top: 200, width: 800, height: 600, unit: 'pixel' });
    expect(parseOcrCrop('{"left": 50, "top": 60, "width": 400, "height": 300}')).toEqual({ left: 50, top: 60, width: 400, height: 300, unit: 'pixel' });
    expect(parseOcrCrop('10%, 15%, 70%, 60%')).toEqual({ left: 10, top: 15, width: 70, height: 60, unit: 'percent' });
    expect(parseOcrCrop({ left: 5, top: 5, width: 90, height: 90, unit: 'percent' })).toEqual({ left: 5, top: 5, width: 90, height: 90, unit: 'percent' });

    expect(() => parseOcrCrop('invalid')).toThrow('Crop must be specified');
    expect(() => parseOcrCrop({ left: -1, top: 0, width: 100, height: 100 })).toThrow('cannot be negative');
    expect(() => parseOcrCrop({ left: 0, top: 0, width: 0, height: 100 })).toThrow('greater than zero');
    expect(() => parseOcrCrop({ left: 80, top: 0, width: 30, height: 50, unit: 'percent' })).toThrow('boundary');
    expect(() => parseOcrCrop({ left: 0, top: 120, width: 50, height: 50, unit: 'percent' })).toThrow('cannot exceed 100%');
  });

  it('applies rotation and crop to images, rejecting out-of-bounds or invalid regions', async () => {
    const bytes = await syntheticCareImage();
    const rotated = await applyImageTransform(bytes, { rotation: 90 });
    const metaRotated = await sharp(rotated).metadata();
    expect(metaRotated.width).toBeLessThanOrEqual(2400);
    expect(metaRotated.height).toBeLessThanOrEqual(2400);

    const cropped = await applyImageTransform(bytes, { crop: { left: 50, top: 100, width: 400, height: 300, unit: 'pixel' } });
    const metaCropped = await sharp(cropped).metadata();
    expect(metaCropped.width).toBe(400);
    expect(metaCropped.height).toBe(300);

    const percentCropped = await applyImageTransform(bytes, { crop: { left: 10, top: 10, width: 50, height: 50, unit: 'percent' } });
    const metaPercent = await sharp(percentCropped).metadata();
    expect(metaPercent.width).toBe(900);
    expect(metaPercent.height).toBe(450);

    await expect(applyImageTransform(bytes, { crop: { left: 1500, top: 800, width: 500, height: 500, unit: 'pixel' } }))
      .rejects.toThrow('within the image bounds');
    await expect(applyImageTransform(bytes, { crop: { left: 0, top: 0, width: 5, height: 5, unit: 'pixel' } }))
      .rejects.toThrow('at least 10x10');
    await expect(applyImageTransform(bytes, { rotation: 45 }))
      .rejects.toThrow('0, 90, 180 or 270');
    await expect(applyImageTransform(Buffer.from('not an image')))
      .rejects.toThrow('invalid');
  });

  it('preserves provenance (rotation, crop, page) through candidate parsing, review and validation', () => {
    const page = {
      page: 3,
      text: '08:15 bottle formula 90 mL',
      engine: 'test-engine',
      confidence: 95,
      rotation: 90,
      crop: { left: 10, top: 20, width: 500, height: 400, unit: 'pixel' as const },
    };
    const rows = parseOcrPages([page], { defaultDate: '2026-10-20', timeFormat: '24h' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source.page).toBe(3);

    const validated = validateOcrCandidate(row, { allowIncomplete: true });
    expect(validated.valid).toBe(true);
    expect(validated.candidate?.source.page).toBe(3);
    expect(validated.candidate?.source.rotation).toBe(90);
    expect(validated.candidate?.source.crop).toEqual(page.crop);

    process.env.ENC_HASH = '22'.repeat(32);
    const sealed = sealOcrState({ rows, pages: [page], options: { rotation: 90, selectedPage: 3, crop: page.crop } }, 'fam:doc');
    const opened = openOcrState<{ rows: OcrCandidate[]; pages: typeof page[]; options: { rotation: number; selectedPage: number; crop: unknown } }>(sealed, 'fam:doc');
    expect(opened.options.selectedPage).toBe(3);
    expect(opened.options.rotation).toBe(90);
    expect(opened.options.crop).toEqual(page.crop);
    expect(opened.pages[0].rotation).toBe(90);
    expect(opened.pages[0].crop).toEqual(page.crop);
    expect(opened.rows[0].source.page).toBe(3);
    expect(opened.rows[0].source.rotation).toBe(90);
    expect(opened.rows[0].source.crop).toEqual(page.crop);
  });

  it('rejects candidate with invalid rotation or crop provenance', () => {
    const baseCandidate = {
      id: 'p1-l1-feed-0',
      eventType: 'feed' as const,
      localDate: '2026-10-20',
      localTime: '08:15',
      endLocalDate: null,
      endLocalTime: null,
      feedType: 'BOTTLE' as const,
      bottleType: 'Formula' as const,
      amount: 90,
      unit: 'ML' as const,
      diaperType: null,
      sleepType: null,
      notes: '',
      approved: false,
      source: {
        page: 1, line: 1, slot: 0, rawText: '08:15 bottle formula 90 mL',
        engine: 'test', confidence: 90, rotation: 45,
      },
      fieldSources: { eventType: 'source' as const, localDate: 'source' as const, localTime: 'source' as const },
      warnings: [],
    };
    expect(validateOcrCandidate(baseCandidate, { allowIncomplete: true }).valid).toBe(false);

    const badCrop = {
      ...baseCandidate,
      source: {
        ...baseCandidate.source,
        rotation: 0,
        crop: { left: -1, top: 0, width: 100, height: 100 },
      },
    };
    expect(validateOcrCandidate(badCrop, { allowIncomplete: true }).valid).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('uses the real local engine for a mixed printed image and a rotated photo', async () => {
    const bytes = await syntheticCareImage();
    const pages = await recognizeOcrDocument(bytes);
    const rows = parseOcrPages(pages, { timeFormat: '24h' });
    expect(rows.filter(row => row.eventType === 'feed')).toHaveLength(2);
    expect(rows.some(row => row.diaperType === 'WET')).toBe(true);
    expect(rows.find(row => row.amount === 90)?.unit).toBe('ML');
    expect(rows.every(row => !row.approved)).toBe(true);
    const rotated = await sharp(bytes).rotate(90).png().toBuffer();
    expect((await recognizeOcrDocument(rotated, 270))[0].text).toContain('90');
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('renders and recognizes each PDF page locally', async () => {
    const pdf = new jsPDF();
    pdf.setFontSize(20);
    pdf.text(['2026-10-20', '08:15 bottle formula 90 mL'], 20, 30);
    pdf.addPage();
    pdf.text(['2026-10-20', '09:30 wet diaper'], 20, 30);
    const pages = await recognizeOcrDocument(Buffer.from(pdf.output('arraybuffer')));
    expect(pages.map(page => page.page)).toEqual([1, 2]);
    expect(pages[0].text).toContain('90');
    expect(pages[1].text.toLowerCase()).toContain('diaper');
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('rejects malformed, oversized-page-count and cancelled documents without care writes', async () => {
    await expect(recognizeOcrDocument(Buffer.from('%PDF-not-a-pdf'))).rejects.toThrow('could not be processed');
    const pdf = new jsPDF();
    for (let i = 1; i < 7; i++) pdf.addPage();
    await expect(recognizeOcrDocument(Buffer.from(pdf.output('arraybuffer')))).rejects.toThrow('1 to 6');
    const controller = new AbortController(); controller.abort();
    await expect(recognizeOcrDocument(await syntheticCareImage(), 0, controller.signal)).rejects.toThrow('cancelled');
  }, 60_000);

  it('binds encrypted draft/audit state to its family and document', () => {
    process.env.ENC_HASH = '11'.repeat(32);
    const sealed = sealOcrState({ raw: 'Synthetic confidential text' }, 'family-a:doc-a');
    expect(sealed).not.toContain('Synthetic');
    expect(openOcrState(sealed, 'family-a:doc-a')).toEqual({ raw: 'Synthetic confidential text' });
    expect(() => openOcrState(sealed, 'family-b:doc-a')).toThrow();
  });
});


describe('native PDF extraction and real synthetic OCR qualification', () => {
  it('rejects broken native text and conservatively identifies raster pages', () => {
    expect(usableNativePdfText('2026-10-20\n08:15 bottle formula 90 mL')).toBe(true);
    expect(usableNativePdfText(' \n\f')).toBe(false);
    expect(usableNativePdfText('bottle \ufffd90 mL')).toBe(false);
    expect(usableNativePdfText('bottle \u0000 90 mL')).toBe(false);
    const header = 'page   num  type   width height color comp bpc  enc interp object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------';
    expect(pdfPageHasRasterContent(header)).toBe(false);
    expect(pdfPageHasRasterContent(header + '\n   2     0 image    1800   900 rgb     3   8 image  no      5  0   200   200 200K 3%')).toBe(true);
    expect(pdfPageHasRasterContent('unrecognized output')).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')('uses native text without assigning invented confidence and preserves a selected page number', async () => {
    const pdf = new jsPDF();
    pdf.text('Unselected first page', 20, 30);
    pdf.addPage();
    pdf.text('Unselected second page', 20, 30);
    pdf.addPage();
    pdf.setFontSize(20);
    pdf.text(['2026-10-20', '08:15 bottle formula 90 mL', '14:00 bottle breast milk 3 oz'], 20, 30);
    const pages = await recognizeOcrDocument(Buffer.from(pdf.output('arraybuffer')), { selectedPage: 3 });
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(3);
    expect(pages[0].engine).toBe('poppler pdftotext; native PDF text');
    expect(pages[0].confidence).toBeNull();
    const feeds = parseOcrPages(pages, { timeFormat: '24h' }).filter(row => row.eventType === 'feed');
    expect(feeds.map(row => [row.localDate, row.localTime, row.amount, row.unit, row.bottleType])).toEqual([
      ['2026-10-20', '08:15', 90, 'ML', 'Formula'],
      ['2026-10-20', '14:00', 3, 'OZ', 'Breast Milk'],
    ]);
    expect(feeds.every(row => !row.approved && row.source.page === 3)).toBe(true);
    console.info('synthetic-native-pdf: 10/10 feeding fields match; approval remains required');
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('falls back per page for scanned PDFs and mixed selectable-header/image pages', async () => {
    const image = await syntheticCareImage();
    const pdf = new jsPDF();
    pdf.setFontSize(20);
    pdf.text(['2026-10-20', '08:15 bottle formula 90 mL'], 20, 30);
    pdf.addPage();
    pdf.addImage(new Uint8Array(image), 'PNG', 10, 30, 190, 95);
    pdf.addPage();
    pdf.text('2026-10-20 care log', 20, 20);
    pdf.addImage(new Uint8Array(image), 'PNG', 10, 40, 190, 95);
    const pages = await recognizeOcrDocument(Buffer.from(pdf.output('arraybuffer')));
    expect(pages.map(page => page.page)).toEqual([1, 2, 3]);
    expect(pages[0].engine).toContain('native PDF text');
    for (const page of pages.slice(1)) {
      expect(page.engine).toContain('tesseract');
      const feeds = parseOcrPages([page], { timeFormat: '24h' }).filter(row => row.eventType === 'feed');
      expect(feeds.map(row => [row.localTime, row.amount, row.unit, row.bottleType])).toEqual([
        ['08:15', 90, 'ML', 'Formula'], ['14:00', 3, 'OZ', 'Breast Milk'],
      ]);
      expect(feeds.every(row => !row.approved)).toBe(true);
    }
    console.info('synthetic-scanned-and-mixed-pdf: 16/16 feeding fields match; all pages locally processed');
  }, 90_000);

  it.skipIf(process.platform !== 'linux')('recognizes a low-contrast JPEG and corrected rotated image without inventing fields', async () => {
    const image = await syntheticCareImage();
    const fixtures = [
      { name: 'low-contrast-jpeg', bytes: await sharp(image).linear(0.15, 190).jpeg({ quality: 90 }).toBuffer(), rotation: 0 },
      { name: 'rotated-png', bytes: await sharp(image).rotate(90).png().toBuffer(), rotation: 270 },
    ];
    for (const fixture of fixtures) {
      const pages = await recognizeOcrDocument(fixture.bytes, fixture.rotation);
      const feeds = parseOcrPages(pages, { timeFormat: '24h' }).filter(row => row.eventType === 'feed');
      expect(feeds.map(row => [row.localTime, row.amount, row.unit])).toEqual([
        ['08:15', 90, 'ML'], ['14:00', 3, 'OZ'],
      ]);
      expect(feeds.every(row => !row.approved)).toBe(true);
      console.info(`synthetic-${fixture.name}: 6/6 time/volume/unit fields match`);
    }
  }, 90_000);
});
