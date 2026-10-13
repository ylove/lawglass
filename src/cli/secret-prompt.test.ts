import { describe, expect, it } from 'vitest';
import { promptSecret, type PromptInput } from './secret-prompt.js';

type Listener = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => void;
function fakeInput(isTTY = true): PromptInput & { press: Listener; raw: boolean[]; listeners: number } {
  let listener: Listener | undefined;
  const raw: boolean[] = [];
  return {
    isTTY, raw,
    get listeners() { return listener ? 1 : 0; },
    setRawMode: (m) => { raw.push(m); },
    resume: () => undefined, pause: () => undefined,
    on: (_e, l) => { listener = l; },
    off: () => { listener = undefined; },
    press: (t, k) => { listener?.(t, k); },
  };
}
const request = { name: 'X_KEY', message: 'Key: ', masked: true } as const;

describe('promptSecret', () => {
  it('masks typed characters, honours backspace, and never writes the secret', async () => {
    const input = fakeInput();
    const written: string[] = [];
    const result = promptSecret(request, input, { write: (t) => { written.push(t); } });
    for (const c of ['a', 'b', 'c']) input.press(c, { name: c });
    input.press(undefined, { name: 'backspace' });
    input.press('\u001b', { name: 'escape' });
    input.press('d', { name: 'd' });
    input.press('\r', { name: 'return' });
    expect(await result).toBe('abd');
    expect(written.join('')).not.toMatch(/[abd]/);
    expect(written.join('')).toContain('***');
    expect(input.raw).toEqual([true, false]);
    expect(input.listeners).toBe(0);
  });

  it('returns undefined for blank input and rejects on ctrl-c', async () => {
    const a = fakeInput();
    const blank = promptSecret(request, a, { write: () => undefined });
    a.press('\r', { name: 'enter' });
    expect(await blank).toBeUndefined();
    const b = fakeInput();
    const cancelled = promptSecret(request, b, { write: () => undefined });
    b.press(undefined, { name: 'c', ctrl: true });
    await expect(cancelled).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects without a TTY', async () => {
    await expect(promptSecret(request, fakeInput(false), { write: () => undefined })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
