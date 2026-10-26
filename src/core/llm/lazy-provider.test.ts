import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { AppError } from '../model/index.js';
import { lazyProvider } from './lazy-provider.js';

describe('lazyProvider', () => {
  it('does not read the real provider until it is used', async () => {
    const get = vi.fn(() => new ScriptedProvider({ reply: 'Hi.' }));
    const lazy = lazyProvider(get);
    expect(get).not.toHaveBeenCalled();
    expect(lazy.id).toBe('mock');
    expect(lazy.model).toBe('scripted');
    let text = '';
    for await (const e of lazy.streamText({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      maxTokens: 10,
    }))
      if (e.type === 'text') text += e.text;
    expect(text).toBe('Hi.');
  });

  it('forwards generateObject', async () => {
    const lazy = lazyProvider(
      () => new ScriptedProvider({ objects: { thing: { n: 1 } } }),
    );
    const { object } = await lazy.generateObject({
      system: 's',
      prompt: 'q',
      schemaName: 'thing',
      schema: z.object({ n: z.number() }),
      maxTokens: 10,
    });
    expect(object).toEqual({ n: 1 });
  });

  it('surfaces MISSING_KEY on first use', () => {
    const lazy = lazyProvider(() => {
      throw new AppError('MISSING_KEY');
    });
    expect(() => lazy.id).toThrow(
      expect.objectContaining({ code: 'MISSING_KEY' }),
    );
    expect(() => lazy.model).toThrow();
  });
});
