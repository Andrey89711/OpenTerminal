import type { ITheme } from '@xterm/xterm';
import type { ColorScheme } from './types';

// Microsoft/terminal defaults.json (MIT); see THIRD_PARTY_NOTICES.md.
// Windows Terminal's default selection background is white when unspecified.
const paletteKeys = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'] as const;
function preset(name: string, background: string, foreground: string, palette: string, cursorColor = '#FFFFFF', selectionBackground = '#FFFFFF'): ColorScheme {
  return { name, background, foreground, cursorColor, selectionBackground,
    ...Object.fromEntries(palette.split(' ').map((color, index) => [paletteKeys[index], `#${color}`])),
  } as ColorScheme;
}
const campbell = '0C0C0C C50F1F 13A10E C19C00 0037DA 881798 3A96DD CCCCCC 767676 E74856 16C60C F9F1A5 3B78FF B4009E 61D6D6 F2F2F2';
const solarized = '002B36 DC322F 859900 B58900 268BD2 D33682 2AA198 EEE8D5 073642 CB4B16 586E75 657B83 839496 6C71C4 93A1A1 FDF6E3';
const tango = '000000 CC0000 4E9A06 C4A000 3465A4 75507B 06989A D3D7CF 555753 EF2929 8AE234 FCE94F 729FCF AD7FA8 34E2E2 EEEEEC';
export const BUILTIN_SCHEMES: ColorScheme[] = [
  preset('Campbell', '#0C0C0C', '#CCCCCC', campbell),
  preset('Campbell Powershell', '#012456', '#CCCCCC', campbell),
  preset('Vintage', '#000000', '#C0C0C0', '000000 800000 008000 808000 000080 800080 008080 C0C0C0 808080 FF0000 00FF00 FFFF00 0000FF FF00FF 00FFFF FFFFFF'),
  preset('One Half Dark', '#282C34', '#DCDFE4', '282C34 E06C75 98C379 E5C07B 61AFEF C678DD 56B6C2 DCDFE4 5A6374 E06C75 98C379 E5C07B 61AFEF C678DD 56B6C2 DCDFE4'),
  preset('One Half Light', '#FAFAFA', '#383A42', '383A42 E45649 50A14F C18301 0184BC A626A4 0997B3 FAFAFA 4F525D DF6C75 98C379 E4C07A 61AFEF C577DD 56B5C1 FFFFFF', '#4F525D', '#383A42'),
  preset('Solarized Dark', '#002B36', '#839496', solarized),
  preset('Solarized Light', '#FDF6E3', '#657B83', solarized, '#002B36', '#2C4D57'),
  preset('Tango Dark', '#000000', '#D3D7CF', tango),
  preset('Tango Light', '#FFFFFF', '#555753', tango, '#000000', '#141414'),
];

export function schemeToXterm(scheme: ColorScheme): ITheme {
  const { name: _name, cursorColor, purple, brightPurple, ...colors } = scheme;
  const rgb = [1, 3, 5].map((start) => Number.parseInt(scheme.selectionBackground.slice(start, start + 2), 16));
  const selectionForeground = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 >= 128 ? '#000000' : '#FFFFFF';
  return { ...colors, cursor: cursorColor, magenta: purple, brightMagenta: brightPurple, selectionForeground };
}
