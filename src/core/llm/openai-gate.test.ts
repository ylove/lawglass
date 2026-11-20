import { describe, expect, it } from 'vitest';
import { asset, httpReplay, KEY } from '../../../tests/llm/http.js';
import { objectRequest } from '../../../tests/llm/provider-tests.js';
import {
  newSpend,
  runInJob,
  type CallEnd,
  type GateCall,
  type JobScope,
} from '../cost/index.js';
import type { UsageEvent } from '../cost/usage.js';
import { Limits } from '../pipeline/limits.js';
import { OpenAIProvider } from './openai.js';

const rejection = (format: string) => ({
  status: 400,
  body: JSON.stringify({
    error: {
      message: `Unsupported ${format}`,
      param: 'response_format',
      type: 'invalid_request_error',
    },
  }),
});

describe('OpenAI format fallback under a per-call gate', () => {
  it('gates each HTTP attempt on its own and reports usage under the last', async () => {
    const replay = httpReplay([
      rejection('json_schema'),
      rejection('json_object'),
      { body: asset('openai-object.json') },
    ]);
    const provider = new OpenAIProvider(
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: KEY },
      { fetch: replay.fetch },
    );
    const calls: GateCall[] = [];
    const usage: UsageEvent[] = [];
    const ends: CallEnd[] = [];
    const job: JobScope = {
      context: { readerId: 'a', jobKind: 'question', jobId: 'j' },
      spent: newSpend(),
      callGate: (c) => {
        calls.push(c);
        return true;
      },
      onUsage: (e) => {
        usage.push(e);
      },
      onCallEnd: (e) => {
        ends.push(e);
      },
    };
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 100,
    });
    await runInJob(job, () =>
      limits.meter(provider).generateObject(objectRequest),
    );
    // Three HTTP requests, three gate decisions, three distinct ids.
    expect(replay.requests).toHaveLength(3);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(3);
    expect(usage.map((u) => u.callId)).toEqual([calls[2]?.callId]);
    expect(ends.map((e) => e.reported)).toEqual([false, false, true]);
  });

  it('a refusal of the second attempt stops it before the second request', async () => {
    const replay = httpReplay([
      rejection('json_schema'),
      { body: asset('openai-object.json') },
    ]);
    const provider = new OpenAIProvider(
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: KEY },
      { fetch: replay.fetch },
    );
    let n = 0;
    const job: JobScope = {
      context: { readerId: 'a', jobKind: 'question', jobId: 'j' },
      spent: newSpend(),
      callGate: () => ++n === 1,
    };
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 100,
    });
    await expect(
      runInJob(job, () => limits.meter(provider).generateObject(objectRequest)),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(replay.requests).toHaveLength(1);
  });
});
