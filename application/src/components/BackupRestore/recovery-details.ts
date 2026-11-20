const COUNTED_DETAILS = [
  '{count} OCR documents have expired or purged source media; their original metadata and retention dates are preserved.',
  '{count} historical configuration values are stored as plaintext. They are preserved exactly and are not counted as authenticated ciphertext.',
] as const;

/** Translate known count-bearing diagnostics without changing the service DTO. */
export function formatRecoveryDetail(message: string, translate: (key: string) => string, locale: string): string {
  for (const template of COUNTED_DETAILS) {
    const suffix = template.slice('{count}'.length);
    if (!message.endsWith(suffix)) continue;
    const raw = message.slice(0, -suffix.length);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) continue;
    return translate(template).replace('{count}', new Intl.NumberFormat(locale).format(Number(raw)));
  }
  return translate(message);
}
