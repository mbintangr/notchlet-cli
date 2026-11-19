const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (supportsColor ? code : '');
const wrap = (str: string, code: string) => (supportsColor ? `${code}${str}${RESET}` : str);

export function section(title: string): string {
  return `${c(BOLD)}${title}${RESET}`;
}

export function kv(label: string, value: string): string {
  return `  ${c(DIM)}${label}${RESET}: ${value}`;
}

export function bullet(text: string, prefix = '•'): string {
  return `  ${c(CYAN)}${prefix}${RESET} ${text}`;
}

export function ok(text: string): string {
  return wrap(text, GREEN);
}

export function err(text: string): string {
  return wrap(text, RED);
}

export function warn(text: string): string {
  return wrap(text, YELLOW);
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `${c(DIM)}(none)${RESET}`;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  const out: string[] = [];
  out.push(line(headers));
  out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function box(lines: string[]): string {
  return lines.join('\n');
}

export function divider(): string {
  return c(DIM) + '──────────────────────────────────────────────────────────────' + RESET;
}
