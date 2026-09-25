import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

/** Opt-in only. This deliberately clears ONLY the synthetic acceptance package.
 * The APK must already contain the build under test and its relay bootstrap guard. */
export async function androidAcceptance(device: string) {
  const adb = process.env.ADB ?? `${process.env.HOME}/Android/Sdk/platform-tools/adb`;
  const pkg = 'app.mysignet.acceptance';
  const run = (...args: string[]) => execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8' });
  run('shell', 'am', 'force-stop', pkg);
  run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  run('shell', 'am', 'start', '-n', `${pkg}/app.mysignet.MainActivity`);
  let pid = '';
  for (let attempt = 0; attempt < 30 && !pid; attempt++) {
    try { pid = run('shell', 'pidof', pkg).trim(); } catch { /* Startup is asynchronous. */ }
    if (!pid) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!pid) throw new Error('Acceptance WebView did not start');
  const port = run('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).trim();
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  for (let attempt = 0; attempt < 30 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!browser) { run('shell', 'am', 'force-stop', pkg); run('forward', '--remove', `tcp:${port}`); throw new Error('Acceptance WebView debug socket unavailable'); }
  const connectedBrowser = browser;
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  // Navigate away from the app before clearing this debug WebView's origin.
  // Some OEM Android builds disallow shell `pm clear`; CDP needs no OS settings change.
  await page.goto('https://localhost/acceptance.html');
  const devtools = await context.newCDPSession(page);
  await devtools.send('Storage.clearDataForOrigin', { origin: 'https://localhost', storageTypes: 'all' });
  await devtools.detach();
  await context.addInitScript(() => { (window as any).__acceptanceAllowRelay = true; });
  const awake = setInterval(() => {
    try { run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); run('shell', 'input', 'keyevent', 'KEYCODE_SHIFT_LEFT'); } catch { /* Test records device disconnect. */ }
  }, 10000);
  return { context, page: context.pages()[0], async close() {
    clearInterval(awake);
    run('shell', 'am', 'force-stop', pkg);
    await connectedBrowser.close();
    run('forward', '--remove', `tcp:${port}`);
  } };
}
