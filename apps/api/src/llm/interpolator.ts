import * as assert from 'node:assert';

export type InterpolationVars = Record<string, string | number | object>;

const VAR_PATTERN = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;

export function interpolate(template: string, vars: InterpolationVars): string {
  const missing: string[] = [];
  const result = template.replace(VAR_PATTERN, (_match, name: string) => {
    if (!(name in vars)) {
      missing.push(name);
      return '';
    }
    const v = vars[name];
    if (v === null || v === undefined) {
      missing.push(name);
      return '';
    }
    return formatValue(v);
  });

  if (missing.length > 0) {
    throw new Error(
      `[interpolator] undefined variables: ${missing.join(', ')} (PoC rule: undefined variables must not be silently emptied)`,
    );
  }

  return result;
}

function formatValue(v: string | number | object): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

export function assertNoVariables(template: string): void {
  const matches = [...template.matchAll(VAR_PATTERN)];
  assert.strictEqual(
    matches.length,
    0,
    `[interpolator] template contains {{...}} placeholders but must be static: ${matches.map((m) => m[1]).join(', ')}`,
  );
}
