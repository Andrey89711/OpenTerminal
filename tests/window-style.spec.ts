import { expect, test } from '@playwright/test';

// Browser checks cover UI/IPC wiring, not native window behavior or ConPTY.
// Real shell lifecycle is covered separately by Rust integration tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    const calls: string[] = [];
    const input: string[] = [];
    const ipcArgs: { command: string; args: Record<string, any> }[] = [];
    host.isTauri = true;
    host.__TEST_CALLS__ = calls;
    host.__TEST_INPUT__ = input;
    host.__TEST_ARGS__ = ipcArgs;
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
        ipcArgs.push({ command, args });
        if (command === 'discover_openprompt') {
          if (host.__TEST_PROMPT_MISSING__) throw 'OpenPrompt не найден. Укажите путь к файлу.';
          return { path: args.configuredPath || "C:\\User's files\\openprompt.exe", version: 'openprompt 0.2.0', dev_fallback: !args.configuredPath };
        }
        if (command === 'openprompt_preview') {
          if (host.__TEST_PREVIEW_FAIL__) throw 'Нужен OpenPrompt 0.2+ с поддержкой preview --json.';
          return { theme: args.theme, ansi: `\x1b[32m${args.theme} C:\\demo\x1b[0m > `, text: `${args.theme} C:\\demo > ` };
        }
        if (command === 'openprompt_session_script') return `Invoke-Expression (& '${args.path.replace(/'/g, "''")}' init powershell | Out-String)\r`;
        if (command === 'openprompt_set_theme' && host.__TEST_SAVE_FAIL__) throw 'Не удалось сохранить тему.';
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

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('button', { name: /Параметры/ }).click();
}

test('OpenPrompt detection, read-only ANSI preview, explicit theme save and font persistence', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByText('openprompt 0.2.0', { exact: false })).toBeVisible();
  const preview = page.getByLabel('ANSI-предпросмотр OpenPrompt');
  await expect(preview.locator('.xterm')).toHaveCount(1);
  await expect(preview.locator('.xterm-rows')).toContainText('classic C:\\demo');
  await page.getByRole('combobox', { name: 'Тема OpenPrompt', exact: true }).selectOption('blocks');
  await expect(preview.locator('.xterm-rows')).toContainText('blocks C:\\demo');
  expect(await page.evaluate(() => (window as any).__TEST_CALLS__)).not.toContain('openprompt_set_theme');
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
  await page.getByRole('button', { name: 'Сохранить тему', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Тема blocks сохранена в OpenPrompt.');
  const save = await page.evaluate(() => (window as any).__TEST_ARGS__.find((call: any) => call.command === 'openprompt_set_theme'));
  expect(save.args).toEqual({ path: "C:\\User's files\\openprompt.exe", theme: 'blocks' });
  await page.getByRole('combobox', { name: /^Шрифт / }).selectOption('CaskaydiaCove Nerd Font');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!).fontFamily)).toBe('CaskaydiaCove Nerd Font');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.reload();
  await openSettings(page);
  await expect(page.locator('select').filter({ has: page.locator('option[value="Consolas"]') })).toHaveValue('CaskaydiaCove Nerd Font');
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
});

test('OpenPrompt session command requires visible command and explicit approval every time', async ({ page }) => {
  await openSettings(page);
  const prepare = page.getByRole('button', { name: 'Включить в текущей сессии…' });
  await expect(prepare).toBeEnabled();
  await prepare.click();
  const expected = "Invoke-Expression (& 'C:\\User''s files\\openprompt.exe' init powershell | Out-String)\r";
  await expect(page.locator('.prompt-confirmation pre')).toHaveText(expected.trimEnd());
  const execute = page.getByRole('button', { name: 'Выполнить команду', exact: true });
  await expect(execute).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
  await page.getByLabel('Подтверждаю выполнение этой команды в текущей сессии').check();
  await execute.click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([expected]);
  await expect(page.locator('.prompt-confirmation')).toHaveCount(0);
  await prepare.click();
  await expect(execute).toBeDisabled();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([expected]);
});

test('OpenPrompt optional path, detection errors and preview errors are recoverable without session writes', async ({ page }) => {
  await page.evaluate(() => { (window as any).__TEST_PROMPT_MISSING__ = true; });
  await openSettings(page);
  await expect(page.getByRole('alert')).toContainText('OpenPrompt не найден');
  await expect(page.getByRole('button', { name: 'Сохранить тему', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).__TEST_PROMPT_MISSING__ = false; });
  await page.getByLabel('Путь к OpenPrompt (необязательно)').fill('C:\\Tools\\openprompt.exe');
  await expect(page.locator('.prompt-found')).toContainText('C:\\Tools\\openprompt.exe');
  await expect(page.getByLabel('ANSI-предпросмотр OpenPrompt').locator('.xterm')).toHaveCount(1);
  await page.evaluate(() => { (window as any).__TEST_PREVIEW_FAIL__ = true; });
  await page.getByRole('combobox', { name: 'Тема OpenPrompt', exact: true }).selectOption('minimal');
  await expect(page.getByRole('alert')).toContainText('preview --json');
  await expect(page.getByLabel('ANSI-предпросмотр OpenPrompt')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
});

test('OpenPrompt cannot enable CMD and never carries approval into another session', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Включить в текущей сессии…' })).toBeEnabled();
  await page.getByRole('button', { name: 'Включить в текущей сессии…' }).click();
  await page.getByLabel('Подтверждаю выполнение этой команды в текущей сессии').check();
  await page.keyboard.press('Control+Shift+t');
  await expect(page.locator('.prompt-confirmation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Параметры' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('button', { name: 'Command Prompt', exact: true }).click();
  await openSettings(page);
  await expect(page.locator('.prompt-found')).toContainText('openprompt 0.2.0');
  await expect(page.getByRole('button', { name: 'Включить в текущей сессии…' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__TEST_INPUT__)).toEqual([]);
});
