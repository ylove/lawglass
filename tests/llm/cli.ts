import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { CliSpawn } from '../../src/core/llm/claude-cli.js';
import { asset } from './http.js';

export function objectTranscript() {
  return (
    asset('claude-cli.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const event = JSON.parse(line) as {
          type: string;
          result?: string;
          event?: { delta?: { type: string; text: string } };
        };
        const text = '{"billNumber":null,"sponsors":null}';
        if (event.type === 'result') event.result = text;
        if (event.event?.delta?.type === 'text_delta')
          event.event.delta.text = text;
        return JSON.stringify(event);
      })
      .join('\n') + '\n'
  );
}
export interface FakeCliOptions {
  transcript?: string | ((prompt: string) => string);
  code?: number;
  stall?: boolean;
  error?: boolean;
  stdinError?: boolean;
}
export function fakeCli(options: FakeCliOptions = {}) {
  const calls: {
    command: string;
    args: readonly string[];
    options: SpawnOptionsWithoutStdio;
    prompt: string;
    emptyCwd: boolean;
  }[] = [];
  const children: FakeChild[] = [];
  class FakeChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kills: NodeJS.Signals[] = [];
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      this.kills.push(signal);
      if (this.exitCode !== null || this.signalCode !== null) return false;
      this.signalCode = signal;
      this.stdout.end();
      this.stderr.end();
      this.emit('close', null, signal);
      return true;
    }
  }
  const spawn: CliSpawn = (command, args, opts) => {
    const child = new FakeChild();
    children.push(child);
    const call = {
      command,
      args,
      options: opts,
      prompt: '',
      emptyCwd: readdirSync(String(opts.cwd)).length === 0,
    };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => {
      call.prompt += chunk.toString();
    });
    child.stdin.on('finish', () => {
      setImmediate(() => {
        if (options.stdinError) {
          child.stdin.emit('error', new Error('private request body'));
          return;
        }
        if (options.stall) return;
        if (options.error)
          child.emit('error', new Error('private request body'));
        else {
          const transcript =
            typeof options.transcript === 'function'
              ? options.transcript(call.prompt)
              : (options.transcript ?? asset('claude-cli.jsonl'));
          const bytes = Buffer.from(transcript);
          for (let i = 0; i < bytes.length; i += 11)
            child.stdout.write(bytes.subarray(i, i + 11));
        }
        child.stdout.end();
        child.stderr.end();
        child.exitCode = options.code ?? (options.error ? 1 : 0);
        child.emit('close', child.exitCode);
      });
    });
    // Only the child's streams, lifecycle events, exit status and kill are used by this adapter.
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, calls, children };
}
