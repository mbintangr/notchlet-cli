import { createInterface } from 'node:readline/promises';

export function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function prompt(text: string): Promise<string> {
  if (!isTty()) throw new Error(`Interactive input required but not a TTY: ${text}`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(text)).trim(); }
  finally { rl.close(); }
}

export async function secret(text = 'Value (input hidden): '): Promise<string> {
  const input = process.stdin, output = process.stderr;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error('Hidden input requires a TTY.');
  output.write(text);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); output.write('\n'); error ? reject(error) : resolve(value); };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Cancelled.'));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

export async function confirm(text: string, defaultYes = false): Promise<boolean> {
  if (!isTty()) return defaultYes;
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
  const answer = (await prompt(`${text}${suffix}: `)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** If value is already set, return it. Otherwise interactively prompt. Returns undefined if not a TTY and no value. */
export async function requiredString(value: string | undefined, promptText: string): Promise<string | undefined> {
  if (value) return value;
  if (!isTty()) return undefined;
  return await prompt(promptText);
}

export async function requiredNumber(value: string | undefined, promptText: string): Promise<number | undefined> {
  if (value) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  if (!isTty()) return undefined;
  while (true) {
    const answer = await prompt(promptText);
    const n = Number(answer);
    if (Number.isSafeInteger(n)) return n;
    process.stderr.write('Enter a valid integer.\n');
  }
}
