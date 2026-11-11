// Documentation screenshots: real UI, synthetic PTY data, no user shell/profile access.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const promptRoot = process.argv[2] ? resolve(process.argv[2]) : null;
const output = join(root, 'docs', 'images');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1421', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((ready, reject) => {
    server.stdout.on('data', data => { if (String(data).includes('1421')) ready(); });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Vite exited: ${code}`)));
  });
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const page = await browser.newPage({ viewport: { width: 1120, height: 740 }, deviceScaleFactor: 1 });
  const sample = '\x1b]0;PowerShell\x07\x1b[96mPS C:\\Projects\\demo>\x1b[0m Get-ChildItem\r\n\r\n    Directory: C:\\Projects\\demo\r\n\r\nMode       Length Name\r\n----       ------ ----\r\nd-----            src\r\nd-----            tests\r\n-a----       1240 README.md\r\n-a----        680 package.json\r\n\r\n\x1b[96mPS C:\\Projects\\demo>\x1b[0m Write-Host "Ready to build" -ForegroundColor Green\r\n\x1b[92mReady to build\x1b[0m\r\n\r\n\x1b[96mPS C:\\Projects\\demo>\x1b[0m ';
  async function open(data) {
    await page.addInitScript(data => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } }, transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async (command, args) => {
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:event|listen') return 1;
          if (command === 'list_windows_terminal_settings') return [];
          if (command === 'create_terminal') args.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(data)) });
        },
      };
    }, data);
    await page.goto('http://127.0.0.1:1421');
    await page.locator('.xterm-rows').filter({ hasText: /Projects/ }).first().waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  await open(sample);
  await page.screenshot({ path: join(output, 'terminal.png'), animations: 'disabled' });
  await page.keyboard.press('Control+,');
  const navigation = page.getByRole('navigation', { name: 'Разделы настроек' });
  await navigation.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await page.screenshot({ path: join(output, 'settings.png'), animations: 'disabled' });
  await navigation.getByRole('button', { name: 'Цветовые схемы', exact: true }).click();
  await page.getByRole('button', { name: 'Solarized Dark', exact: true }).click();
  await page.getByRole('img', { name: 'Предпросмотр цветов терминала, только для чтения' }).locator('.xterm-rows').filter({ hasText: 'Get-ChildItem' }).waitFor();
  await page.screenshot({ path: join(output, 'color-schemes.png'), animations: 'disabled' });
  if (promptRoot) {
    const executable = join(promptRoot, 'target/release/openprompt.exe');
    let ansi = '\x1b]0;OpenPrompt theme previews\x07';
    for (const theme of ['minimal', 'classic', 'blocks']) {
      const preview = JSON.parse(execFileSync(executable, ['preview', '--theme', theme, '--json'], { encoding: 'utf8' }));
      ansi += `\x1b[90mPS C:\\Projects\\demo> openprompt preview --theme ${theme}\x1b[0m\r\n\r\n${preview.ansi.replace(/\r?\n/g, '\r\n')}\r\n\r\n\r\n`;
    }
    await page.close();
    // New context keeps the terminal's default settings and no previous init scripts.
    const context = await browser.newContext({ viewport: { width: 1120, height: 390 } });
    const preview = await context.newPage();
    await preview.addInitScript(data => {
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
        if (command === 'plugin:window|is_maximized') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'create_terminal') args.channel.onmessage({ type: 'data', data: Array.from(new TextEncoder().encode(data)) });
      } };
    }, ansi);
    await preview.goto('http://127.0.0.1:1421');
    await preview.locator('.xterm-rows').filter({ hasText: /blocks/ }).waitFor();
    await preview.evaluate(() => document.fonts.ready);
    const promptOutput = join(promptRoot, 'docs/images');
    await mkdir(promptOutput, { recursive: true });
    await preview.screenshot({ path: join(promptOutput, 'themes.png'), animations: 'disabled' });
  }
  console.log('Documentation screenshots saved.');
} finally {
  await browser?.close();
  const closed = once(server, 'exit');
  server.kill();
  await closed;
}
