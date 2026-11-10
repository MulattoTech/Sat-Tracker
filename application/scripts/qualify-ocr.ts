#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOcrQualification } from '../src/lib/ocr/qualification/run';
import { QualificationError } from '../src/lib/ocr/qualification/manifest';

// This is an owner-invoked private benchmark, never an HTTP endpoint or a CI corpus uploader.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--manifest') throw new QualificationError('USAGE_REQUIRE_MANIFEST');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const privateRoot = path.join(root, '.local');
  const reportDirectory = path.join(privateRoot, 'ocr-qualification', 'reports');
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(privateRoot), resolvedReports = await realpath(reportDirectory);
  const relative = path.relative(resolvedRoot, resolvedReports);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new QualificationError('PATH_OUTSIDE_PRIVATE_CORPUS');
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const report = await runOcrQualification({ privateRoot, manifestPath: path.resolve(args[1]), revision });
  const runId = randomUUID();
  await writeFile(path.join(resolvedReports, `${runId}.json`), JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  // No manifest/input paths, OCR text, annotations or child/caregiver identifiers are printed.
  console.log(JSON.stringify({ runId, executionStatus: report.executionStatus,
    representativeHandwriting: report.representativeHandwriting.status,
    measuredDocuments: report.measuredDocuments, failedDocuments: report.failedDocuments }));
  if (report.executionStatus === 'ERROR') process.exitCode = 2;
}

main().catch(error => {
  console.error(JSON.stringify({ executionStatus: 'ERROR',
    code: error instanceof QualificationError ? error.code : 'PRIVATE_QUALIFICATION_FAILED' }));
  process.exitCode = 2;
});
