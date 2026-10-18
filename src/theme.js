export const THEME_TOKENS = [
  '--dsw-alias-bg-layer-1', '--dsw-alias-surface-l1', '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary', '--dsw-alias-border-l2', '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary', '--dsw-alias-interactive-bg-hover',
];

export function normalizeTheme(theme) {
  if (!theme || !['light', 'dark'].includes(theme.colorScheme) || !theme.tokens || typeof theme.tokens !== 'object' || Array.isArray(theme.tokens)) throw new Error('无效的待办窗口主题。');
  const tokens = {};
  for (const name of THEME_TOKENS) {
    const value = theme.tokens[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 300 || !/^[#a-zA-Z0-9%.,() \-+/]+$/.test(value) || /\b(?:url|var)\s*\(/i.test(value)) throw new Error('无效的主题颜色。');
    tokens[name] = value;
  }
  return { colorScheme: theme.colorScheme, tokens };
}
