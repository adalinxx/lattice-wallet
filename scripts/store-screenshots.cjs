// Capture actual packaged UI in an isolated Chrome profile with disposable
// keys. PLAYWRIGHT_MODULE points to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'lattice-store-capture-'));
  const extension = resolve('dist');
  const output = resolve('release/store-assets');
  mkdirSync(output, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup/index.html?view=wallet`);
    await page.getByRole('button', { name: 'Create wallet', exact: true }).waitFor();
    await page.screenshot({ path: join(output, '01-welcome.png') });
    await page.getByRole('button', { name: 'Restore or import', exact: true }).click();
    await page.getByRole('button', { name: 'Recovery phrase or private key', exact: true }).click();
    await page.getByPlaceholder('password (min 8)', { exact: true }).fill('Disposable screenshot password');
    await page.getByPlaceholder('confirm password', { exact: true }).fill('Disposable screenshot password');
    await page.locator('textarea').fill('a7'.repeat(32));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: /Use Lattice\.build/ }).waitFor();
    await page.screenshot({ path: join(output, '02-node-choice.png') });
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'lock' }));
    await page.reload();
    await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor();
    await page.screenshot({ path: join(output, '03-unlock.png') });
    console.log(`Screenshots: ${output}; Chrome ${context.browser().version()}`);
  } finally {
    if (context) await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
