import { expect, test, type Page } from '@playwright/test';

const importedFixture = `// Windows Terminal sample, not actual user configuration
{
  "copyOnSelect": true,
  "defaultProfile": "{11111111-1111-1111-1111-111111111111}",
  "profiles": { "defaults": { "font": { "face": "Consolas", "size": 18 }, "colorScheme": "One Half Dark" }, "list": [
    { "guid": "{11111111-1111-1111-1111-111111111111}", "name": "Импортированная CMD", "commandline": "cmd.exe" },
    { "name": "Небезопасный профиль", "commandline": "pwsh.exe -EncodedCommand aaaa" },
  ] },
  "actions": [{ "command": "paste", "keys": "ctrl+v" }],
}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((fixture) => {
    const host = window as any;
    host.isTauri = true;
    host.__CALLS__ = [];
    host.__INPUT__ = [];
    host.__CLIPBOARD__ = '';
    const callbacks: Record<number, (...args: any[]) => any> = {};
    let callbackId = 0;
    host.__EVENTS__ = {};
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => host.__CLIPBOARD__,
      writeText: async (text: string) => { host.__CLIPBOARD__ = text; },
    } });
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } }, transformCallback: (callback: (...args: any[]) => any) => { callbacks[++callbackId] = callback; return callbackId; }, unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        host.__CALLS__.push({ command, args });
        if (command === 'plugin:window|is_maximized') return false;
        if (command === 'plugin:event|listen') { host.__EVENTS__[args.event] = callbacks[args.handler]; return args.handler; }
        if (command === 'plugin:window|close') await host.__EVENTS__['tauri://close-requested']?.({ event: 'tauri://close-requested', id: 1, payload: null });
        if (command === 'list_windows_terminal_settings') return [{ id: 'stable', label: 'Windows Terminal' }];
        if (command === 'read_windows_terminal_settings') return fixture;
        if (command === 'write_terminal') host.__INPUT__.push(args.data);
        if (command === 'create_terminal') args.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(`\x1b]0;${args.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'}\x07PS C:\\demo> `)) });
      },
    };
  }, importedFixture);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('PS C:');
});

const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('openterminal.settings')!));
const count = (page: Page, name: string) => page.evaluate((name) => (window as any).__CALLS__.filter((entry: any) => entry.command === name).length, name);
const settings = async (page: Page) => {
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('tab', { name: 'Параметры', exact: true })).toHaveAttribute('aria-selected', 'true');
};
const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button', { name, exact: true }).click();

test('settings are one persistent tab and cancelled drafts never affect sessions', async ({ page }, info) => {
  await settings(page); await settings(page); await settings(page);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await section(page, 'Оформление');
  await page.getByLabel('Тема приложения').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('tab', { name: 'PowerShell', exact: true }).click();
  await page.getByRole('tab', { name: 'Параметры', exact: true }).click();
  await expect(page.getByLabel('Тема приложения')).toHaveValue('light');
  await section(page, 'Добавить новый профиль');
  await page.screenshot({ path: info.outputPath('settings-add-profile.png') });
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect((await saved(page)).theme).toBe('dark');
  expect(await count(page, 'create_terminal')).toBe(1);
  expect(await count(page, 'close_terminal')).toBe(0);
});

test('saved appearance and terminal defaults update without restarting sessions', async ({ page }) => {
  await settings(page);
  await section(page, 'Оформление');
  await page.getByLabel('Тема приложения').selectOption('light');
  await page.getByLabel('Ширина вкладок').selectOption('compact');
  await section(page, 'По умолчанию');
  await page.getByLabel(/^Гарнитура шрифта/).fill('Consolas');
  await page.getByLabel('Размер шрифта', { exact: true }).fill('18');
  await page.getByLabel('Форма курсора').selectOption('block');
  await page.getByLabel(/^Размер истории/).fill('2000');
  await page.getByLabel('Цветовая схема', { exact: true }).selectOption('One Half Dark');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.app')).toHaveClass(/tabs-compact/);
  await page.getByRole('tab', { name: 'PowerShell', exact: true }).click();
  await expect(page.locator('.terminal-pane.active')).toHaveCSS('background-color', 'rgb(40, 44, 52)');
  expect(await count(page, 'create_terminal')).toBe(1);
  expect(await count(page, 'close_terminal')).toBe(0);
  expect(await saved(page)).toMatchObject({ theme: 'light', fontSize: 18, fontFamily: 'Consolas', cursorStyle: 'block', scrollback: 2000, colorScheme: 'One Half Dark' });
  await page.reload();
  expect(await saved(page)).toMatchObject({ fontSize: 18, cursorStyle: 'block' });
});

test('new and duplicate profiles are draft-only and launch with fixed shell arguments', async ({ page }) => {
  await settings(page); await section(page, 'Добавить новый профиль');
  await page.getByLabel('Оболочка', { exact: true }).selectOption('cmd');
  await page.getByRole('button', { name: 'Добавить профиль', exact: true }).click();
  await page.getByLabel('Имя профиля').fill('Рабочая CMD');
  await page.getByLabel(/^Начальный каталог/).fill('C:\\Projects');
  expect((await saved(page)).profiles).toHaveLength(4);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect((await saved(page)).profiles).toHaveLength(5);
  expect(await count(page, 'create_terminal')).toBe(1);
  await page.getByRole('button', { name: 'Выбрать оболочку' }).click();
  await page.getByRole('navigation', { name: 'Сессии терминала' }).getByRole('button', { name: 'Рабочая CMD', exact: true }).click();
  await expect.poll(() => count(page, 'create_terminal')).toBe(2);
  const args = await page.evaluate(() => {
    const call = (window as any).__CALLS__.filter((entry: any) => entry.command === 'create_terminal').at(-1);
    return { shell: call.args.shell, startingDirectory: call.args.startingDirectory };
  });
  expect(args).toEqual({ shell: 'cmd', startingDirectory: 'C:\\Projects' });
  await settings(page); await section(page, 'Добавить новый профиль');
  const original = (await saved(page)).profiles.find((p: any) => p.name === 'Рабочая CMD');
  await page.getByLabel('Копировать профиль').selectOption(original.id);
  await page.getByRole('button', { name: 'Дублировать профиль', exact: true }).click();
  await expect(page.getByLabel('Имя профиля')).toHaveValue('Рабочая CMD (копия)');
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  expect((await saved(page)).profiles).toHaveLength(5);
});

test('Windows Terminal import is previewed, explicitly applied and never launches imported commands', async ({ page }) => {
  await settings(page);
  expect(await count(page, 'list_windows_terminal_settings')).toBe(0);
  await section(page, 'Импорт настроек');
  await expect(page.getByLabel('Источник Windows Terminal')).toBeEnabled();
  await page.getByRole('button', { name: 'Подготовить предпросмотр', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Предпросмотр импорта' })).toBeVisible();
  await expect(page.getByText(/Небезопасный профиль/)).toBeVisible();
  expect((await saved(page)).profiles).toHaveLength(4);
  await page.getByRole('button', { name: 'Применить к черновику', exact: true }).click();
  expect((await saved(page)).profiles).toHaveLength(4);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const config = await saved(page);
  expect(config.profiles).toHaveLength(5);
  expect(config).toMatchObject({ fontSize: 18, fontFamily: 'Consolas', copyOnSelect: true });
  expect(config.defaultProfile).toContain('imported-');
  expect(JSON.stringify(config)).not.toContain('EncodedCommand');
  expect(await count(page, 'create_terminal')).toBe(1);
  expect(await page.evaluate(() => (window as any).__INPUT__)).toEqual([]);
  await page.reload();
  const shell = await page.evaluate(() => (window as any).__CALLS__.find((entry: any) => entry.command === 'create_terminal').args.shell);
  expect(shell).toBe('cmd');
});

test('JSON editing reports errors and only commits after both apply and save', async ({ page }) => {
  await settings(page);
  await page.getByRole('button', { name: 'Редактировать JSON', exact: true }).click();
  await page.getByLabel('JSON настроек', { exact: true }).fill('{broken');
  await page.getByRole('button', { name: 'Применить JSON', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const next = { ...await saved(page), fontSize: 22, cursorStyle: 'underline' };
  await page.getByLabel('JSON настроек', { exact: true }).fill(JSON.stringify(next));
  await page.getByRole('button', { name: 'Применить JSON', exact: true }).click();
  expect((await saved(page)).fontSize).toBe(14);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect(await saved(page)).toMatchObject({ fontSize: 22, cursorStyle: 'underline' });
});

async function clipboardPaste(page: Page, text: string) {
  await page.locator('.terminal-pane.active .terminal-host').evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}

test('all multiline paste paths require confirmation and cancel writes nothing', async ({ page }) => {
  await clipboardPaste(page, 'echo first\necho second');
  const dialog = page.getByRole('dialog', { name: 'Вставить несколько строк?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Вставить', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as any).__INPUT__)).toEqual([]);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await clipboardPaste(page, 'echo first\necho second');
  await dialog.getByRole('button', { name: 'Вставить', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__INPUT__.join(''))).toBe('echo first\recho second');
  await page.evaluate(() => { (window as any).__CLIPBOARD__ = 'echo another\necho last'; });
  await page.keyboard.press('Control+Shift+v');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__INPUT__.join(''))).toBe('echo first\recho second');
});

test('copy-on-select and right-click paste are functional opt-in settings', async ({ page }) => {
  await settings(page); await section(page, 'Взаимодействие');
  await page.getByRole('switch', { name: 'Копировать при выделении', exact: true }).check();
  await page.getByRole('switch', { name: 'Вставлять правой кнопкой мыши', exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('tab', { name: 'PowerShell', exact: true }).click();
  const span = page.locator('.terminal-pane.active .xterm-rows > div').first().locator('span').first();
  await expect(span).toContainText('PS C:');
  const rect = (await span.boundingBox())!;
  const cell = rect.width / (await span.textContent())!.length;
  await page.mouse.move(rect.x + cell * .1, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + cell * 2.1, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__CLIPBOARD__)).toBe('PS');
  await page.evaluate(() => { (window as any).__CLIPBOARD__ = 'echo ready'; });
  await page.locator('.terminal-pane.active .terminal-host').dispatchEvent('contextmenu');
  await expect.poll(() => page.evaluate(() => (window as any).__INPUT__.join(''))).toBe('echo ready');
});

test('color presets have a read-only live preview and adapt to a narrow window', async ({ page }, info) => {
  await settings(page); await section(page, 'Цветовые схемы');
  await page.getByRole('button', { name: 'Solarized Dark', exact: true }).click();
  const preview = page.getByRole('img', { name: 'Предпросмотр цветов терминала, только для чтения' });
  await expect(preview.locator('.xterm')).toHaveCount(1);
  await expect(preview.locator('.xterm-rows')).toContainText('Get-ChildItem');
  expect(await count(page, 'create_terminal')).toBe(1);
  await page.screenshot({ path: info.outputPath('settings-colors.png') });
  await page.setViewportSize({ width: 600, height: 400 });
  await page.getByRole('button', { name: 'Скрыть разделы', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
});

test('window close confirmation supports cancellation and confirmed destruction', async ({ page }) => {
  await settings(page); await section(page, 'Взаимодействие');
  await page.getByRole('switch', { name: 'Подтверждать закрытие окна с сессиями', exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Закрыть терминал?' });
  await expect(dialog).toBeVisible();
  expect(await count(page, 'plugin:window|destroy')).toBe(0);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  await dialog.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  await expect.poll(() => count(page, 'plugin:window|destroy')).toBe(1);
});

test('NoProfile is passed only to newly launched PowerShell sessions', async ({ page }) => {
  await settings(page); await section(page, 'PowerShell');
  await page.getByRole('switch', { name: 'Не загружать профиль PowerShell', exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect(await count(page, 'create_terminal')).toBe(1);
  await page.getByRole('button', { name: 'Новая вкладка', exact: true }).click();
  await expect.poll(() => count(page, 'create_terminal')).toBe(2);
  const flags = await page.evaluate(() => (window as any).__CALLS__.filter((entry: any) => entry.command === 'create_terminal').map((entry: any) => entry.args.noProfile));
  expect(flags).toEqual([false, true]);
});

test('saving shows one square black toast on the right, including in light theme', async ({ page }) => {
  await settings(page); await section(page, 'Оформление');
  await page.getByLabel('Тема приложения').selectOption('light');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const notice = page.locator('.app-notice');
  await expect(notice).toHaveText('Настройки сохранены');
  await expect(notice).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(notice).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(notice).toHaveCSS('border-radius', '0px');
  await expect(notice).toHaveCSS('box-shadow', 'none');
  expect((await notice.boundingBox())!.x).toBeGreaterThan(800);
  await expect(page.locator('.settings-workspace-notice')).toHaveCount(0);
  await page.getByRole('tab', { name: 'PowerShell', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(notice).toBeHidden({ timeout: 4000 });
});

test('failed settings persistence does not show a saved confirmation or apply the draft', async ({ page }) => {
  await settings(page); await section(page, 'Оформление');
  await page.getByLabel('Тема приложения').selectOption('light');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); }; });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить настройки');
  await expect(page.locator('.app-notice')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
