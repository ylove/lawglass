import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { AskEvent, IngestEvent } from '../core/model/index.js';
import { readSseEvents } from '../web/sse.js';

/** Cites the first section in the prompt: hard on the first try, easy on the regeneration. */
function hardThenEasy(second?: string) {
  return new ScriptedProvider({
    reply: (req) => {
      const text = JSON.stringify(req.messages);
      const id = /section=\\"([^\\"]+)\\"/.exec(text)?.[1] ?? 'x';
      if (text.includes('6th-grade reader'))
        return (
          second ??
          `The agency must write rules. Towns must follow them to take part [S:${id}].`
        );
      return `The Administrator shall promulgate regulations establishing eligibility requirements for participating municipalities, which must demonstrate substantial compliance with applicable environmental standards [S:${id}].`;
    },
  });
}

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve('https://govinfo.gov/a.txt', makeSectionedText(), 'text/plain');
});
afterEach(async () => {
  await env.cleanup();
});

async function askSummary(a: Hono) {
  const ingest = await a.request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://govinfo.gov/a.txt' }),
  });
  let docId = '';
  for await (const e of readSseEvents(ingest, IngestEvent))
    if (e.type === 'done') docId = e.doc.docId;
  const res = await a.request(`/api/docs/${docId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chipId: 'summary' }),
  });
  // Read to the end of the stream: the server still writes after `done` (usage, scenario), and
  // those writes must finish before the temp directory is removed.
  let answer;
  for await (const e of readSseEvents(res, AskEvent))
    if (e.type === 'done') answer = e.answer;
  if (!answer) throw new Error('no answer');
  return answer;
}

describe('reading level on the server', () => {
  test('a private server regenerates a too-hard answer', async () => {
    const provider = hardThenEasy();
    Object.assign(env.runtime, { answerProvider: provider });
    const answer = await askSummary(
      createApp(env.runtime, { localOnly: false }),
    );
    expect(answer.simplified).toBe(true);
    expect(answer.text).toContain('The agency must write rules');
  });

  test('a public server makes no second model call per visitor', async () => {
    const provider = hardThenEasy();
    Object.assign(env.runtime, { answerProvider: provider });
    const answer = await askSummary(
      createApp(env.runtime, { publicMode: true, clientIp: () => '1.1.1.1' }),
    );
    expect(answer.simplified).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });

  test('a refused regeneration is logged by code only, never with text', async () => {
    Object.assign(env.runtime, {
      answerProvider: hardThenEasy('Towns get money.'),
    });
    const lines: string[] = [];
    await askSummary(
      createApp(env.runtime, {
        localOnly: false,
        logWriter: (l) => lines.push(l),
      }),
    );
    const entry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === 'regeneration_refused');
    expect(entry).toMatchObject({ code: 'NO_CITATION' });
    expect(lines.join('')).not.toContain('Towns get money');
  });
});
