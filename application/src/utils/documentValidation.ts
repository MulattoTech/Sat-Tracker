/**
 * Document and attachment upload validation utilities.
 * Validates file sizes, declared MIME types, and magic byte signatures
 * to prevent polyglot files, script injection, and MIME confusion attacks.
 */

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedDocumentMimeType = typeof ALLOWED_DOCUMENT_MIME_TYPES[number];

export interface DocumentValidationResult {
  valid: boolean;
  detectedMimeType: AllowedDocumentMimeType | null;
  error?: string;
}

/**
 * Sniff magic bytes from a buffer to determine if it is a genuine
 * PDF, PNG, JPEG, or WebP document.
 */
export function identifyDocumentBytes(buffer: Buffer): AllowedDocumentMimeType | null {
  if (buffer.length < 4) return null;

  // PDF signature: starts with %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
    return 'application/pdf';
  }

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return 'image/png';
  }

  // JPEG signature: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // WebP signature: RIFF [4 bytes] WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Validate an uploaded attachment buffer against size, allowed MIME types,
 * and genuine binary signatures.
 */
export function validateAttachmentUpload(
  buffer: Buffer,
  declaredMimeType?: string,
  maxSizeBytes: number = MAX_ATTACHMENT_SIZE_BYTES
): DocumentValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, detectedMimeType: null, error: 'File is required and cannot be empty.' };
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = Math.round(maxSizeBytes / (1024 * 1024));
    return { valid: false, detectedMimeType: null, error: `File size exceeds the ${maxMb}MB limit.` };
  }

  const detected = identifyDocumentBytes(buffer);
  if (!detected) {
    return {
      valid: false,
      detectedMimeType: null,
      error: 'Unsupported file format. Only authentic PDF, PNG, JPEG, and WebP files are allowed.',
    };
  }

  // If a MIME type was declared by the client, ensure it is compatible with the detected type
  if (declaredMimeType) {
    const normalizedDeclared = declaredMimeType.trim().toLowerCase();
    // Allow octet-stream fallback from some clients if magic bytes are valid, but reject conflicting types
    if (
      normalizedDeclared !== 'application/octet-stream' &&
      normalizedDeclared !== detected &&
      !(detected === 'image/jpeg' && normalizedDeclared === 'image/jpg')
    ) {
      return {
        valid: false,
        detectedMimeType: detected,
        error: `File signature (${detected}) does not match declared type (${declaredMimeType}).`,
      };
    }
  }

  return { valid: true, detectedMimeType: detected };
}

/**
 * Sanitize original filename for Content-Disposition header and disk records.
 * Strips control characters, directory separators, and bounds length.
 */
export function sanitizeFilename(name: string, fallback = 'document'): string {
  const sanitized = name
    .replace(/\.\.+/g, '_')
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .trim();
  return sanitized.slice(0, 180) || fallback;
}
