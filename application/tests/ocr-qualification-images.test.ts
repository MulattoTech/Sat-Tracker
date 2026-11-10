import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { jsPDF } from 'jspdf';
import { runOcrQualification } from '@/src/lib/ocr/qualification/run';
import { privatePath } from '@/src/lib/ocr/qualification/manifest';
import type { ExpectedRow, QualificationDocument } from '@/src/lib/ocr/qualification/types';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function corpus() {
  const root = await mkdtemp(path.join(tmpdir(), 'sat-qualification-test-')); temporary.push(root);
  const privateRoot = path.join(root, '.local'); await mkdir(privateRoot, { mode: 0o700 });
  return { root, privateRoot, manifestPath: path.join(privateRoot, 'PRIVATE-MANIFEST.json') };
}

const provenance: QualificationDocument['provenance'] = {
  origin: 'synthetic-print', humanHandwritten: false, representativeOfFamilyWorkflow: false,
  groundTruthDoubleChecked: true, consentForLocalEvaluation: true,
};
const expectedRows = (page = 1): ExpectedRow[] => [{
  page, transcription: '08:15 bottle formula 90 mL',
  fields: { eventType: 'feed', localDate: '2026-10-20', localTime: '08:15', amount: 90, unit: 'ML' },
}, {
  page, transcription: '14:00 bottle breast milk 3 oz',
  fields: { eventType: 'feed', localDate: '2026-10-20', localTime: '14:00', amount: 3, unit: 'OZ' },
}];

async function careImage() {
  return sharp(Buffer.from('<svg width="1800" height="650" xmlns="http://www.w3.org/2000/svg">'
    + '<rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="52">'
    + '<text x="70" y="120">2026-10-20</text><text x="70" y="240">08:15 bottle formula 90 mL</text>'
    + '<text x="70" y="360">14:00 bottle breast milk 3 oz</text></g></svg>')).png().toBuffer();
}

describe('private qualification IO boundaries', () => {
  it('refuses a source outside the private directory, including through a symlink', async () => {
    const files = await corpus();
    const outside = path.join(files.root, 'PRIVATE-OUTSIDE.png'); await writeFile(outside, 'sensitive');
    await symlink(outside, path.join(files.privateRoot, 'linked.png'));
    await expect(privatePath(files.privateRoot, outside)).rejects.toThrow('PATH_OUTSIDE_PRIVATE_CORPUS');
    await expect(privatePath(files.privateRoot, path.join(files.privateRoot, 'linked.png')))
      .rejects.toThrow('PATH_OUTSIDE_PRIVATE_CORPUS');
  });

  it('redacts failed inputs and excludes failures from measured-document counts', async () => {
    const files = await corpus();
    await writeFile(path.join(files.privateRoot, 'PRIVATE-FAMILY-NAME.png'), 'PRIVATE-RAW-TEXT');
    await writeFile(files.manifestPath, JSON.stringify({ version: 1, documents: [{
      input: 'PRIVATE-FAMILY-NAME.png', provenance, expectedRows: expectedRows(),
    }] }));
    const report = await runOcrQualification(files);
    expect(report).toMatchObject({ executionStatus: 'ERROR', measuredDocuments: 0, failedDocuments: 1,
      representativeHandwriting: { status: 'BLOCKED' }, careRecordsWritten: 0 });
    const rendered = JSON.stringify(report);
    for (const secret of [files.root, 'PRIVATE-FAMILY-NAME', 'PRIVATE-RAW-TEXT', 'PRIVATE-MANIFEST']) {
      expect(rendered).not.toContain(secret);
    }
  });
});

describe('real image/document qualification harness', () => {
  it.skipIf(process.platform !== 'linux')('executes actual PNG/JPEG/mixed-PDF OCR and duplicate uploads without claiming handwriting PASS', async () => {
    const files = await corpus(), png = await careImage();
    await writeFile(path.join(files.privateRoot, 'PRIVATE-LOG.png'), png);
    await writeFile(path.join(files.privateRoot, 'photo.jpg'), await sharp(png).jpeg({ quality: 90 }).toBuffer());
    const pdf = new jsPDF(); pdf.setFontSize(20);
    pdf.text(['2026-10-20', '08:15 bottle formula 90 mL', '14:00 bottle breast milk 3 oz'], 20, 30);
    pdf.addPage(); pdf.addImage(new Uint8Array(png), 'PNG', 10, 30, 190, 69);
    await writeFile(path.join(files.privateRoot, 'mixed.pdf'), Buffer.from(pdf.output('arraybuffer')));
    const documents: QualificationDocument[] = [
      { input: 'PRIVATE-LOG.png', provenance, parse: { timeFormat: '24h' }, expectedRows: expectedRows() },
      { input: 'photo.jpg', provenance, parse: { timeFormat: '24h' }, expectedRows: expectedRows(),
        repeatOf: 0, repeatKind: 'transformed-scan' },
      { input: 'mixed.pdf', provenance, parse: { timeFormat: '24h' }, expectedRows: [...expectedRows(), ...expectedRows(2)] },
      { input: 'PRIVATE-LOG.png', provenance, parse: { timeFormat: '24h' }, expectedRows: expectedRows(),
        repeatOf: 0, repeatKind: 'same-bytes' },
    ];
    await writeFile(files.manifestPath, JSON.stringify({ version: 1, documents }));
    const report = await runOcrQualification(files);
    expect(report).toMatchObject({ executionStatus: 'COMPLETE', measuredDocuments: 4, failedDocuments: 0,
      allDocuments: { expectedRows: 10, predictedRows: 10, matchedRows: 10, rowRecall: 1, rowPrecision: 1,
        fields: { localDate: { accuracy: 1 }, localTime: { accuracy: 1 }, amount: { accuracy: 1 }, unit: { accuracy: 1 } } },
      repeatedUploadRecognition: { declaredPairs: 2, comparedPairs: 2, consistentPairs: 2, emptyPairs: 0 },
      representativeHandwriting: { status: 'BLOCKED', documents: 0 },
      canonicalDuplicateDetection: 'NOT_RUN', reviewedImportCorrectness: 'NOT_RUN', careRecordsWritten: 0 });
    const rendered = JSON.stringify(report);
    for (const secret of [files.privateRoot, 'PRIVATE-LOG', 'PRIVATE-MANIFEST', '2026-10-20', 'bottle formula']) {
      expect(rendered).not.toContain(secret);
    }
    expect(report.results[2]).toMatchObject({ engines: ['native-pdf-text', 'tesseract'] });
    // Running the harness did not modify the input manifest or source bytes.
    expect(JSON.parse(await readFile(files.manifestPath, 'utf8'))).toEqual({ version: 1, documents });
    expect(await readFile(path.join(files.privateRoot, 'PRIVATE-LOG.png'))).toEqual(png);
  }, 120_000);

  it.skipIf(process.platform !== 'linux')('does not accept selectable PDF text as a representative handwriting-image result', async () => {
    const files = await corpus(), pdf = new jsPDF(); pdf.setFontSize(20);
    pdf.text(['2026-10-20', '08:15 bottle formula 90 mL', '14:00 bottle breast milk 3 oz'], 20, 30);
    await writeFile(path.join(files.privateRoot, 'native.pdf'), Buffer.from(pdf.output('arraybuffer')));
    await writeFile(files.manifestPath, JSON.stringify({ version: 1, documents: [{
      input: 'native.pdf', provenance: { ...provenance, origin: 'family-paper-log',
        humanHandwritten: true, representativeOfFamilyWorkflow: true },
      parse: { timeFormat: '24h' }, expectedRows: expectedRows(),
    }] }));
    const report = await runOcrQualification(files);
    expect(report.executionStatus).toBe('COMPLETE');
    expect(report.representativeHandwriting.status).toBe('BLOCKED');
    expect(report.representativeHandwriting.documents).toBe(0);
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('rejects a declared exact-repeat pair when the actual source bytes differ', async () => {
    const files = await corpus();
    for (const name of ['one', 'two']) {
      const pdf = new jsPDF(); pdf.setFontSize(20);
      pdf.text(['2026-10-20', '08:15 bottle formula 90 mL', '14:00 bottle breast milk 3 oz'], 20, 30);
      // Different private PDF metadata must not masquerade as an exact repeated upload.
      pdf.setProperties({ title: name });
      await writeFile(path.join(files.privateRoot, `${name}.pdf`), Buffer.from(pdf.output('arraybuffer')));
    }
    const documents = ['one', 'two'].map((name, index) => ({ input: `${name}.pdf`, provenance,
      parse: { timeFormat: '24h' }, expectedRows: expectedRows(),
      ...(index ? { repeatOf: 0, repeatKind: 'same-bytes' } : {}) }));
    await writeFile(files.manifestPath, JSON.stringify({ version: 1, documents }));
    const report = await runOcrQualification(files);
    expect(report.executionStatus).toBe('ERROR');
    expect(report.repeatedUploadRecognition).toMatchObject({ invalidExactPairs: 1, consistentPairs: 0 });
  }, 60_000);
});
