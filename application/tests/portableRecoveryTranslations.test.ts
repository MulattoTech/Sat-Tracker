import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatRecoveryDetail } from '@/src/components/BackupRestore/recovery-details';

const messages: string[] = [
  'View recovery setup instructions', 'Source revision', 'Exported at (UTC)',
  '{count} OCR documents have expired or purged source media; their original metadata and retention dates are preserved.',
  '{count} historical configuration values are stored as plaintext. They are preserved exactly and are not counted as authenticated ciphertext.',
  'Diagnostic API logs and environment files are excluded. The source encryption key must remain separately protected.',
  "Complete backup and recovery",
  "Create a portable backup of all application metadata and encrypted media. Download its recovery key separately and keep both private.",
  "Installation administrator password",
  "Download complete backup",
  "Download recovery key",
  "Preparing download...",
  "Download complete.",
  "Recovery requires a separate, empty instance started in recovery mode. Existing installation data cannot be replaced here.",
  "Open isolated recovery",
  "Isolated recovery",
  "Recover into an empty destination. The normal application stays unavailable until an operator activates this instance separately.",
  "Recovery operator token",
  "Source recovery key",
  "Backup archive",
  "Check recovery destination",
  "Inspect backup",
  "Recover into this empty destination",
  "Working...",
  "Destination is empty and ready.",
  "Recovery is blocked. Review the destination status before continuing.",
  "Review this backup before recovery.",
  "Archive SHA-256",
  "Source database",
  "Coverage",
  "Complete",
  "Incomplete",
  "Models",
  "Records",
  "Media files",
  "Media bytes",
  "Omissions",
  "Diagnostics",
  "Recovery verified.",
  "Activation is required. This screen does not start the normal application or change deployment settings.",
  "This archive cannot be restored.",
  "Choose a backup archive first.",
  "Enter the recovery operator token and source recovery key.",
  "This backup exceeds the supported upload size.",
  "The request failed. Your selected file and entered values have been kept.",
  "The selected archive or recovery key changed. Inspect the backup again.",
  "The download could not be completed.",
  "Use the source installation’s exact ENC_HASH, including its original letter case."
];

describe('portable recovery UI localization', () => {
  it('localizes OCR count diagnostics and formats the count in the selected locale', () => {
    const values = JSON.parse(readFileSync('src/localization/translations/de.json', 'utf8'));
    const result = formatRecoveryDetail('1000 OCR documents have expired or purged source media; their original metadata and retention dates are preserved.', key => values[key] ?? key, 'de');
    expect(result).toContain('1.000 OCR-Dokumenten');
    expect(result).not.toContain('have expired');
  });
  it('localizes plaintext warnings while preserving their count and truthful distinction', () => {
    const values = JSON.parse(readFileSync('src/localization/translations/fr.json', 'utf8'));
    const result = formatRecoveryDetail('2 historical configuration values are stored as plaintext. They are preserved exactly and are not counted as authenticated ciphertext.', key => values[key] ?? key, 'fr');
    expect(result).toContain('2 valeurs de configuration historiques');
    expect(result).toContain('en clair');
    expect(result).not.toContain('{count}');
  });
  it('uses ordinary localization for static diagnostics without guessing unknown counts', () => {
    expect(formatRecoveryDetail('Some future diagnostic.', key => 'translated: ' + key, 'en')).toBe('translated: Some future diagnostic.');
  });
  for (const locale of ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'nb', 'pt-pt', 'pt-br', 'ro', 'hi']) {
    it(`provides every recovery control, limitation and receipt message in ${locale}`, () => {
      const values = JSON.parse(readFileSync(path.join(process.cwd(), 'src/localization/translations', locale + '.json'), 'utf8'));
      for (const message of messages) expect(values[message], message).toEqual(expect.stringMatching(/\S/));
      expect(values['Use the source installation’s exact ENC_HASH, including its original letter case.']).toContain('ENC_HASH');
    });
  }
});
