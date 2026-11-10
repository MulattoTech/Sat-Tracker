import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const reportDir = path.join(process.cwd(), 'test-results');
fs.mkdirSync(reportDir, { recursive: true });

// Read staging access details from container
const accessJson = execSync('docker exec babytracker-ocr-staging cat /app/env/ocr-staging-access.json', { encoding: 'utf8' });
const access = JSON.parse(accessJson);

const base = 'http://127.0.0.1:3124';
const report = {
  status: 'PENDING',
  checks: [],
  screenshots: [],
  viewports: {},
  startedAt: new Date().toISOString(),
};

try {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Pre-seed authentication and selected family/baby in localStorage
  await context.addInitScript(({ token, access }) => {
    localStorage.setItem('authToken', token);
    localStorage.setItem('unlockTime', String(Date.now()));
    localStorage.setItem('caretakerId', access.caretakerId);
    localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('selectedFamily', JSON.stringify({
      id: access.familyId,
      slug: access.familySlug,
      name: 'Synthetic OCR staging',
    }));
    localStorage.setItem(`selectedBaby_${access.familyId}`, JSON.stringify({
      id: access.babyId,
      firstName: 'Synthetic',
      lastName: 'Fixture',
    }));
  }, { token: access.token, access });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  console.log(`Navigating to ${base}/${access.familySlug}/ocr-import?babyId=${access.babyId}...`);
  await page.goto(`${base}/${access.familySlug}/ocr-import?babyId=${access.babyId}`, { waitUntil: 'networkidle' });

  // 1. Check title & headings
  await page.getByRole('heading', { name: 'Document import', exact: true }).waitFor({ timeout: 10000 });
  report.checks.push('Page rendered "Document import" heading');

  // 2. Check workflow stages
  const workflow = page.locator('.ocr-workflow');
  await workflow.waitFor({ timeout: 5000 });
  const stageText = await workflow.textContent();
  if (stageText.includes('Upload source') && stageText.includes('Review and correct')) {
    report.checks.push('Workflow stages 1-3 visible');
  }

  // 3. Check document history selector and open the saved document
  const historySelect = page.getByRole('combobox', { name: 'Document history' });
  await historySelect.waitFor({ timeout: 5000 });
  report.checks.push('Document history selector available');

  // Select the synthetic document from the history dropdown
  await historySelect.selectOption({ label: 'synthetic-staging-care-log.png · Imported · 10/27/2026' });

  // Verify review heading for saved import
  await page.getByRole('heading', { name: 'Saved import review', exact: true }).waitFor({ timeout: 10000 });
  report.checks.push('Opened saved import review from history');

  // Verify the rows are rendered
  const event1 = page.locator('article[aria-label="Draft event 1"]');
  await event1.waitFor({ timeout: 5000 });
  const event1Amount = await event1.getByLabel('Feeding amount').inputValue();
  if (event1Amount !== '95') throw new Error(`Expected feed amount 95, got ${event1Amount}`);
  report.checks.push('Row 1 (feed corrected to 95 mL) verified in review list');

  const event2 = page.locator('article[aria-label="Draft event 2"]');
  await event2.waitFor({ timeout: 5000 });
  const event2Diaper = await event2.getByLabel('Diaper type').inputValue();
  if (event2Diaper !== 'WET') throw new Error(`Expected diaper type WET, got ${event2Diaper}`);
  report.checks.push('Row 2 (diaper type WET) verified in review list');

  // Desktop screenshot
  const desktopPath = path.join(reportDir, 'preview-desktop.png');
  await page.screenshot({ path: desktopPath, fullPage: true });
  report.screenshots.push(desktopPath);

  // 4. Viewport tests: Tablet & Phone responsiveness (no horizontal scrollbar overflow)
  const viewports = [
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'phone', width: 390, height: 844 },
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(300);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    const fits = scrollWidth <= innerWidth + 1;

    report.viewports[vp.name] = { scrollWidth, innerWidth, fits };
    if (!fits) {
      throw new Error(`${vp.name} viewport horizontally overflows: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
    }
    report.checks.push(`${vp.name} viewport (width ${vp.width}px) fits without horizontal overflow`);

    const vpPath = path.join(reportDir, `preview-${vp.name}.png`);
    await page.screenshot({ path: vpPath, fullPage: true });
    report.screenshots.push(vpPath);
  }

  // 5. Verify no console page errors
  if (pageErrors.length > 0) {
    throw new Error(`Page console errors detected: ${pageErrors.join('; ')}`);
  }
  report.checks.push('Zero page/client-side JavaScript exceptions');

  report.status = 'PASS';
  report.completedAt = new Date().toISOString();
  await browser.close();
} catch (error) {
  report.status = 'FAIL';
  report.error = error.message;
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exit(1);
