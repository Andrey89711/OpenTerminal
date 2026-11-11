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
    host.__TEST_CLIPBOARD__ = '';
    host.__TEST_CLIPBOARD_READS__ = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { host.__TEST_CLIPBOARD_READS__ = Number(host.__TEST_CLIPBOARD_READS__) + 1; return host.__TEST_CLIPBOARD__; },
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

test('RU to EN layout changes preserve physical copy, paste and interrupt shortcuts', async ({ page }) => {
  await selectPromptPrefix(page);
  const input = page.locator('.terminal-pane.active .xterm-helper-textarea');
  await input.dispatchEvent('keydown', { key: 'с', code: 'KeyC', keyCode: 229, ctrlKey: true, bubbles: true, cancelable: true });
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_COPIED__)).toBe('PS');
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
  await page.locator('.terminal-pane.active .xterm-screen').click();
  for (const [key, text] of [['м', 'echo russian'], ['v', 'echo english']]) {
    await page.evaluate((text) => { (window as any).__TEST_CLIPBOARD__ = text; }, text);
    await input.dispatchEvent('keydown', { key, code: 'KeyV', keyCode: 229, ctrlKey: true, bubbles: true, cancelable: true });
    await expect.poll(() => page.evaluate(() => (window as any).__TEST_CLIPBOARD_READS__)).toBe(text === 'echo russian' ? 1 : 2);
  }
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__.join(''))).toBe('echo russianecho english');
  for (const key of ['с', 'c']) {
    await input.dispatchEvent('keydown', { key, code: 'KeyC', keyCode: 229, ctrlKey: true, bubbles: true, cancelable: true });
  }
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__.filter((data: string) => data === '\x03').length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__TEST_CALLS__.filter((name: string) => name === 'create_terminal').length)).toBe(1);
});

test('plain Ctrl+V pastes once and Ctrl+Shift+T/W work with Russian symbols', async ({ page }) => {
  await page.locator('.terminal-pane.active .xterm-screen').click();
  await page.evaluate(() => { (window as any).__TEST_CLIPBOARD__ = 'echo once'; });
  await page.keyboard.press('Control+v');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__.join(''))).toBe('echo once');
  await page.locator('.terminal-pane.active .xterm-helper-textarea').dispatchEvent('keydown', { key: 'е', code: 'KeyT', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.locator('.terminal-pane.active .xterm-helper-textarea').dispatchEvent('keydown', { key: 'ц', code: 'KeyW', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('missing physical codes use RU fallback and AltGr does not trigger paste', async ({ page }) => {
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('PS C:');
  const input = page.locator('.terminal-pane.active .xterm-helper-textarea');
  await input.dispatchEvent('keydown', { key: 'м', code: 'KeyV', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  expect(await page.evaluate(() => (window as any).__TEST_CLIPBOARD_READS__)).toBe(0);
  await page.evaluate(() => { (window as any).__TEST_CLIPBOARD__ = 'echo fallback'; });
  await input.dispatchEvent('keydown', { key: 'м', code: '', ctrlKey: true, bubbles: true, cancelable: true });
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_CLIPBOARD_READS__)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__.join(''))).toContain('echo fallback');
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
  await expect(notice).toHaveText('Текст скопирован');
  await expect(notice).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(notice).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(notice).toHaveCSS('border-radius', '0px');
  await expect(notice).toHaveCSS('box-shadow', 'none');
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
  await expect(page.getByRole('status')).toHaveText('Не удалось скопировать текст');
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
  await page.getByRole('button', { name: 'Оформление', exact: true }).click();
  await page.getByLabel('Тема приложения').selectOption('light');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
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

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('button', { name: /Параметры/ }).click();
}

test('font selection persists without restarting or writing to the shell', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await page.getByLabel(/^Гарнитура шрифта/).fill('CaskaydiaCove Nerd Font');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontFamily)).toBe('CaskaydiaCove Nerd Font');
  await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__TEST_CALLS__.filter((name: string) => name === 'create_terminal').length)).toBe(1);
  await page.reload();
  await openSettings(page);
  await page.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await expect(page.getByLabel(/^Гарнитура шрифта/)).toHaveValue('CaskaydiaCove Nerd Font');
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
});

test('settings discard legacy prompt integration and never discover or activate a prompt engine', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('openterminal.settings', JSON.stringify({ fontSize: 16, theme: 'light', fontFamily: 'Consolas', promptPath: 'C:\\Tools\\openprompt.exe' })));
  await page.reload();
  await openSettings(page);
  await page.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await expect(page.getByLabel(/^Гарнитура шрифта/)).toHaveValue('Consolas');
  await expect(page.getByText('OpenPrompt', { exact: true })).toHaveCount(0);
  const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!));
  expect(migrated).toMatchObject({ version: 2, fontSize: 16, theme: 'light', fontFamily: 'Consolas' });
  expect(migrated).not.toHaveProperty('promptPath');
  const calls = await page.evaluate(() => (window as any).__TEST_CALLS__ as string[]);
  expect(calls.some((name) => name.includes('openprompt'))).toBe(false);
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
});
