import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import type {
  ChoicePromptRequest,
  SecretPromptRequest,
} from '../core/config.js';
import { AppError } from '../core/model/index.js';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}
export interface PromptInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(
    event: 'keypress',
    listener: (text: string | undefined, key: Key) => void,
  ): unknown;
  off(
    event: 'keypress',
    listener: (text: string | undefined, key: Key) => void,
  ): unknown;
}
export interface PromptOutput {
  write(text: string): unknown;
}

export function promptSecret(
  request: SecretPromptRequest,
  input: PromptInput = process.stdin,
  output: PromptOutput = process.stdout,
): Promise<string | undefined> {
  if (!input.isTTY)
    return Promise.reject(
      new AppError(
        'INVALID_INPUT',
        'Masked input requires an interactive terminal.',
      ),
    );
  // Node attaches the keypress decoder to stdin. Injected test streams emit decoded events.
  if (input === process.stdin) emitKeypressEvents(process.stdin);
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    const characters: string[] = [];
    const finish = () => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };
    const onKeypress = (text: string | undefined, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish();
        reject(new AppError('INVALID_INPUT', 'The key prompt was cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
        resolve(characters.join('') || undefined);
      } else if (key.name === 'backspace' || key.name === 'delete') {
        if (characters.pop() !== undefined) output.write('\b \b');
      } else if (
        text &&
        !key.ctrl &&
        !key.meta &&
        !/[\u0000-\u001f\u007f]/.test(text)
      ) {
        characters.push(...Array.from(text));
        output.write('*'.repeat(Array.from(text).length));
      }
    };
    output.write(request.message);
    input.setRawMode(true);
    input.on('keypress', onKeypress);
    input.resume();
  });
}

/** A plain (echoed) single-line choice prompt; the answer is not a secret. */
export async function promptChoice(
  request: ChoicePromptRequest,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string | undefined> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `${request.message} (${request.choices.join(', ')}; blank to skip): `,
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}
