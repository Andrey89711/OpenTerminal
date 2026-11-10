import { expect, test } from '@playwright/test';

// Browser checks cover UI/IPC wiring, not native window behavior or ConPTY.
// Real shell lifecycle is covered separately by Rust integration tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    const calls: string[] = [];
    const input: string[] = [];
    host.isTauri = true;
    host.__TEST_CALLS__ = calls;
    host.__TEST_INPUT__ = input;
    host.__TEST_COPIED__ = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (host.__TEST_COPY_FAIL__) throw new Error('Clipboard unavailable');
        host.__TEST_COPIED__ = text;
      },
    } });
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args: Record<string, any>) => {
        calls.push(command);
        if (command === 'write_terminal') input.push(args.data);
        if (command === 'plugin:window|is_maximized') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'create_terminal') {
          const text = '\x1b]0;' + (args.shell === 'cmd' ? 'Command Prompt' : 'PowerShell') + '\x07PS C:\\Users\\Andrey> ';
          args.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(text)) });
        }
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('Ctrl+wheel changes and persists font size, not page zoom or the shell session', async ({ page }) => {
  const pane = page.locator('.terminal-pane.active');
  await pane.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(15);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(14);
  await page.mouse.wheel(0, -120);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(14);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  expect(await page.evaluate(() => (window as any).__TEST_CALLS__.filter((name: string) => name === 'create_terminal').length)).toBe(1);
  await pane.locator('.terminal-host').dispatchEvent('wheel', { ctrlKey: true, deltaY: -120 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(15);
});

test('font zoom is bounded to the settings range', async ({ page }) => {
  const host = page.locator('.terminal-pane.active .terminal-host');
  for (let i = 0; i < 30; i++) await host.dispatchEvent('wheel', { ctrlKey: true, deltaY: -120 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(28);
  for (let i = 0; i < 30; i++) await host.dispatchEvent('wheel', { ctrlKey: true, deltaY: 120 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontSize)).toBe(10);
});

async function selectPromptPrefix(page: import('@playwright/test').Page) {
  const span = page.locator('.terminal-pane.active .xterm-rows > div').first().locator('span').first();
  await expect(span).toContainText('PS C:');
  const rect = (await span.boundingBox())!;
  const cellWidth = rect.width / (await span.textContent())!.length;
  await page.mouse.move(rect.x + cellWidth * 0.1, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + cellWidth * 2.1, rect.y + rect.height / 2, { steps: 5 });
  await page.mouse.up();
}

test('Ctrl+C copies only selected text, shows confirmation on the right, and preserves interrupt', async ({ page }) => {
  await selectPromptPrefix(page);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_COPIED__)).toBe('PS');
  const notice = page.getByRole('status');
  await expect(notice).toHaveText('Copied to clipboard');
  const rect = (await notice.boundingBox())!;
  expect(rect.x).toBeGreaterThan(800);
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).not.toContain('\x03');
  await expect(notice).toBeHidden({ timeout: 4000 });
  await page.locator('.terminal-pane.active .xterm-screen').click();
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__)).toContain('\x03');
});

test('clipboard failure does not claim success or interrupt the process', async ({ page }) => {
  await page.evaluate(() => { (window as any).__TEST_COPY_FAIL__ = true; });
  await selectPromptPrefix(page);
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('status')).toHaveText('Copy failed');
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).not.toContain('\x03');
});

test('one compact titlebar, Campbell background, no extra chrome', async ({ page }, testInfo) => {
  await expect(page.locator('.titlebar')).toHaveCSS('height', '40px');
  await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(12, 12, 12)');
  await expect(page.locator('footer, .toolbar, .brand')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Закрыть окно', exact: true })).toBeVisible();
  const workspace = await page.locator('.workspace').boundingBox();
  expect(workspace?.y).toBe(40);
  expect(workspace?.height).toBe(700);
  await page.screenshot({ path: testInfo.outputPath('window-style.png') });
});

test('profiles, tab shortcuts, and closing a session still work', async ({ page }) => {
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('button', { name: 'Command Prompt', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: 'Command Prompt' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+t');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.keyboard.press('Control+Shift+w');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_CALLS__.filter((name: string) => name === 'close_terminal').length)).toBe(1);
});

test('settings are in the dropdown and theme persists without restarting shells', async ({ page }) => {
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('button', { name: /Параметры/ }).click();
  await page.getByLabel('Оформление').selectOption('light');
  await page.keyboard.press('Escape');
  await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await page.evaluate(() => (window as any).__TEST_CALLS__.filter((name: string) => name === 'create_terminal').length)).toBe(1);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('caption buttons use the window API and remain visible with many tabs', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 400 });
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Новая вкладка', exact: true }).click();
  await page.getByRole('button', { name: 'Свернуть', exact: true }).click();
  await page.getByRole('button', { name: 'Развернуть', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__TEST_CALLS__);
  expect(calls).toContain('plugin:window|minimize');
  expect(calls).toContain('plugin:window|toggle_maximize');
  expect(calls).toContain('plugin:window|close');
  const close = await page.getByRole('button', { name: 'Закрыть окно', exact: true }).boundingBox();
  expect(close!.x + close!.width).toBeLessThanOrEqual(600);
});
