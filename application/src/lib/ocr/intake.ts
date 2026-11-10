import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { OcrError } from './errors';
import type { OcrCrop } from './types';

const exec = promisify(execFile);
export const OCR_LIMITS = {
  bytes: 12 * 1024 * 1024,
  pages: 6,
  maxPdfPages: 100,
  pixels: 24_000_000,
  rows: 200,
  text: 120_000,
} as const;
export const OCR_MODEL_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2';
const activeFamilies = new Set<string>();

export function acquireOcrSlot(familyId: string): () => void {
  if (activeFamilies.has(familyId) || activeFamilies.size >= 2) {
    throw new OcrError('Document recognition is busy. Try again after the current document finishes.', 429);
  }
  activeFamilies.add(familyId);
  return () => { activeFamilies.delete(familyId); };
}

export function identifyOcrUpload(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' {
  if (!bytes.length || bytes.length > OCR_LIMITS.bytes) throw new OcrError('Choose a document smaller than 12 MB.');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  throw new OcrError('Supported documents are JPEG, PNG, WebP and unencrypted PDF. Convert HEIC photos before uploading.');
}

export interface OcrIntakeOptions {
  readonly rotation?: number;
  readonly selectedPage?: number;
  readonly crop?: OcrCrop;
  readonly signal?: AbortSignal;
}

export interface RecognizedPage {
  page: number;
  text: string;
  confidence: number | null;
  engine: string;
  image: Buffer;
  rotation?: number;
  crop?: OcrCrop;
}

export function validateOcrCrop(crop: OcrCrop): OcrCrop {
  if (!Number.isFinite(crop.left) || !Number.isFinite(crop.top) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
    throw new OcrError('Crop coordinates must be finite numbers.');
  }
  if (crop.left < 0 || crop.top < 0) {
    throw new OcrError('Crop coordinates cannot be negative.');
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new OcrError('Crop dimensions must be greater than zero.');
  }
  if (crop.unit === 'percent') {
    if (crop.left > 100 || crop.top > 100 || crop.width > 100 || crop.height > 100) {
      throw new OcrError('Percentage crop coordinates cannot exceed 100%.');
    }
    if (crop.left + crop.width > 100 || crop.top + crop.height > 100) {
      throw new OcrError('Percentage crop extends beyond 100% of the image boundary.');
    }
  }
  return {
    left: crop.left,
    top: crop.top,
    width: crop.width,
    height: crop.height,
    ...(crop.unit ? { unit: crop.unit } : {}),
  };
}

export function parseOcrCrop(input: unknown): OcrCrop {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      try {
        return parseOcrCrop(JSON.parse(trimmed));
      } catch {
        throw new OcrError('Invalid crop JSON.');
      }
    }
    const parts = trimmed.split(/[\s,]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 4) {
      const hasPercent = parts.some(p => p.endsWith('%'));
      const nums = parts.map(p => Number(p.replace(/%$/, '')));
      if (nums.some(n => !Number.isFinite(n))) throw new OcrError('Crop coordinates must be finite numbers.');
      return validateOcrCrop({
        left: nums[0],
        top: nums[1],
        width: nums[2],
        height: nums[3],
        unit: hasPercent ? 'percent' : 'pixel',
      });
    }
    throw new OcrError('Crop must be specified as left,top,width,height or JSON object.');
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const left = Number(obj.left);
    const top = Number(obj.top);
    const width = Number(obj.width);
    const height = Number(obj.height);
    const unit = obj.unit === 'percent' ? 'percent' : 'pixel';
    return validateOcrCrop({ left, top, width, height, unit });
  }
  throw new OcrError('Invalid crop specification.');
}

export async function applyImageTransform(
  input: Buffer,
  options: { rotation?: number; crop?: OcrCrop } = {},
): Promise<Buffer> {
  const rotation = options.rotation ?? 0;
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new OcrError('Choose a rotation of 0, 90, 180 or 270 degrees.');
  }

  try {
    const metadata = await sharp(input, { limitInputPixels: OCR_LIMITS.pixels }).metadata();
    if ((metadata.pages || 1) !== 1) {
      throw new OcrError('Animated or multi-frame images are not supported.');
    }

    let pipeline = sharp(input, { limitInputPixels: OCR_LIMITS.pixels }).autoOrient();
    if (rotation) {
      pipeline = pipeline.rotate(rotation);
    }

    if (options.crop) {
      const crop = validateOcrCrop(options.crop);
      const orientedBuffer = await pipeline.toBuffer();
      const orientedMeta = await sharp(orientedBuffer).metadata();
      const imgWidth = orientedMeta.width || 0;
      const imgHeight = orientedMeta.height || 0;

      if (imgWidth === 0 || imgHeight === 0) {
        throw new OcrError('The image has invalid dimensions.');
      }

      let left: number;
      let top: number;
      let width: number;
      let height: number;

      if (crop.unit === 'percent') {
        left = Math.floor((crop.left / 100) * imgWidth);
        top = Math.floor((crop.top / 100) * imgHeight);
        width = Math.min(imgWidth - left, Math.round((crop.width / 100) * imgWidth));
        height = Math.min(imgHeight - top, Math.round((crop.height / 100) * imgHeight));
      } else {
        left = Math.round(crop.left);
        top = Math.round(crop.top);
        width = Math.round(crop.width);
        height = Math.round(crop.height);
      }

      if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > imgWidth || top + height > imgHeight) {
        throw new OcrError('The crop region must be within the image bounds.');
      }
      if (width < 10 || height < 10) {
        throw new OcrError('Choose a crop area of at least 10x10 pixels.');
      }

      pipeline = sharp(orientedBuffer).extract({ left, top, width, height });
    }

    return await pipeline
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw new OcrError('The image is invalid or exceeds the 24-megapixel limit.');
  }
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    if (process.platform !== 'linux') throw new OcrError('Run local recognition in the Linux OCR-enabled application container.', 503);
    const result = await exec('prlimit', ['--as=805306368', '--cpu=25', '--fsize=67108864', '--', command, ...args], {
      timeout: 25_000, killSignal: 'SIGKILL', maxBuffer: 3 * 1024 * 1024,
      signal, windowsHide: true, env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    return result.stdout;
  } catch (error) {
    if (error instanceof OcrError) throw error;
    if (signal?.aborted) throw new OcrError('Recognition cancelled. No care records were created.', 499);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OcrError('Local OCR tools are unavailable. Install Tesseract, Poppler and prlimit in the application image.', 503);
    }
    // Native errors can contain document text or filenames; never return or log them.
    throw new OcrError('The document could not be processed within the local limits. Try a smaller, unencrypted page.');
  }
}

async function verifiedEngine(signal?: AbortSignal): Promise<string> {
  const version = (await run('tesseract', ['--version'], signal)).split('\n')[0].trim();
  const languages = await run('tesseract', ['--list-langs'], signal);
  const directory = process.env.TESSDATA_PREFIX || languages.match(/"([^"]+)"/)?.[1];
  if (!directory) throw new OcrError('The local English OCR model could not be verified.', 503);
  let model: Buffer;
  try { model = await readFile(path.join(directory, 'eng.traineddata')); }
  catch { throw new OcrError('The pinned English OCR model is unavailable.', 503); }
  if (createHash('sha256').update(model).digest('hex') !== OCR_MODEL_SHA256) {
    throw new OcrError('The English OCR model differs from the verified model. Install the pinned model before recognizing documents.', 503);
  }
  return `${version}; eng-fast sha256:${OCR_MODEL_SHA256}; psm6`;
}

export function readTesseractTsv(tsv: string): { text: string; confidence: number | null } {
  const lines = new Map<string, string[]>();
  const confidences: number[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const cells = row.split('\t');
    if (cells[0] !== '5' || cells.length < 12) continue;
    const word = cells.slice(11).join('\t').trim();
    if (!word) continue;
    const id = cells.slice(1, 5).join('-');
    if (!lines.has(id)) lines.set(id, []);
    lines.get(id)!.push(word);
    const confidence = Number(cells[10]);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 100) confidences.push(confidence);
  }
  return {
    text: [...lines.values()].map(words => words.join(' ')).join('\n'),
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  };
}

/** Native text is evidence, not an OCR confidence score. Reject broken font maps. */
export function usableNativePdfText(text: string): boolean {
  const visible = text.replace(/\s/g, '');
  return visible.length >= 4 && /[\p{L}\p{N}]/u.test(visible)
    && !/[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/u.test(text);
}

/** Only trust a text-only page; a raster layer may contain additional care entries. */
export function pdfPageHasRasterContent(listing: string): boolean {
  const lines = listing.split(/\r?\n/);
  if (!lines.some(line => /^\s*page\s+num\s+type\s+width\s+height\b/.test(line))) return true;
  return lines.some(line => /^\s*\d+\s+\d+\s+\S+\s+\d+\s+\d+\b/.test(line));
}

async function extractNativePdfPage(source: string, page: number, signal?: AbortSignal): Promise<string | null> {
  let extracted: string;
  try {
    extracted = await run('pdftotext', ['-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', source, '-'], signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Malformed/missing text layers fall back to local recognition of this page.
    return null;
  }
  const text = extracted.replace(/\f/g, '\n').trim();
  if (text.length > OCR_LIMITS.text) throw new OcrError('Too much text was found. Upload a smaller section.');
  if (!usableNativePdfText(text)) return null;
  try {
    const images = await run('pdfimages', ['-f', String(page), '-l', String(page), '-list', source], signal);
    // A mixed page can contain both selectable headers and scanned handwriting.
    // OCR the whole page rather than silently dropping the image-only content.
    if (pdfPageHasRasterContent(images)) return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  return text;
}

export async function recognizeOcrDocument(
  bytes: Buffer,
  optionsOrRotation: number | OcrIntakeOptions = 0,
  maybeSignal?: AbortSignal,
): Promise<RecognizedPage[]> {
  const options: OcrIntakeOptions = typeof optionsOrRotation === 'number'
    ? { rotation: optionsOrRotation, signal: maybeSignal }
    : optionsOrRotation;
  const rotation = options.rotation ?? 0;
  const signal = options.signal ?? maybeSignal;
  const selectedPage = options.selectedPage;
  const crop = options.crop;

  const mime = identifyOcrUpload(bytes);
  if (![0, 90, 180, 270].includes(rotation)) throw new OcrError('Choose a rotation of 0, 90, 180 or 270 degrees.');
  let engine: string | undefined;
  const dir = await mkdtemp(path.join(tmpdir(), 'babytracker-ocr-'));
  try {
    let targetPages: number[] = [1];
    const source = path.join(dir, 'source.pdf');
    if (mime === 'application/pdf') {
      await writeFile(source, bytes, { mode: 0o600 });
      const info = await run('pdfinfo', [source], signal);
      if (/^Encrypted:\s+yes/im.test(info)) throw new OcrError('Password-protected PDFs are not supported.');
      const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(count) || count < 1) throw new OcrError('Choose a PDF with at least 1 page.');
      if (count > OCR_LIMITS.maxPdfPages) throw new OcrError(`Choose a PDF with at most ${OCR_LIMITS.maxPdfPages} pages.`);
      if (selectedPage !== undefined) {
        if (!Number.isInteger(selectedPage) || selectedPage < 1 || selectedPage > count) {
          throw new OcrError(`Selected page ${selectedPage} is out of range. Document has ${count} page${count === 1 ? '' : 's'}.`);
        }
        targetPages = [selectedPage];
      } else {
        if (count > OCR_LIMITS.pages) throw new OcrError('Choose a PDF with 1 to 6 pages, or select a single page.');
        targetPages = Array.from({ length: count }, (_, i) => i + 1);
      }
    }
    const pages: RecognizedPage[] = [];
    for (const page of targetPages) {
      if (signal?.aborted) throw new OcrError('Recognition cancelled.', 499);
      let input = bytes;
      if (mime === 'application/pdf') {
        const prefix = path.join(dir, `render-${page}`);
        await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '2400', '-png', source, prefix], signal);
        input = await readFile(`${prefix}.png`);
      }
      const image = await applyImageTransform(input, { rotation, crop });
      const imagePath = path.join(dir, `page-${page}.png`);
      await writeFile(imagePath, image, { mode: 0o600 });
      // Crop/rotation requests must be recognized from the transformed preview.
      // Otherwise selectable text on a text-only PDF page preserves exact digits.
      const nativeText = mime === 'application/pdf' && !rotation && !crop
        ? await extractNativePdfPage(source, page, signal)
        : null;
      let result: { text: string; confidence: number | null };
      let pageEngine: string;
      if (nativeText !== null) {
        result = { text: nativeText, confidence: null };
        pageEngine = 'poppler pdftotext; native PDF text';
      } else {
        engine ??= await verifiedEngine(signal);
        // Explicit output flags work with a model-only TESSDATA_PREFIX.
        const tsv = await run('tesseract', [imagePath, 'stdout', '-l', 'eng', '--psm', '6', '-c', 'tessedit_create_tsv=1'], signal);
        if (!tsv.startsWith('level\tpage_num\tblock_num\t')) throw new OcrError('The local recognition engine returned an unsupported result. No care records were created.', 503);
        result = readTesseractTsv(tsv);
        pageEngine = engine;
      }
      if (result.text.length > OCR_LIMITS.text) throw new OcrError('Too much text was found. Upload a smaller section.');
      pages.push({
        page,
        ...result,
        engine: pageEngine,
        image,
        ...(rotation ? { rotation } : {}),
        ...(crop ? { crop } : {}),
      });
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
