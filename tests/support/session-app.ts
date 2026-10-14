import type { CliRuntime } from '../../src/cli/runtime.js';
import { createApp, type AppOptions } from '../../src/server/app.js';

/** Drive API suites through the same exchange as a browser, preserving Request signals. */
export function createSessionTestApp(
  runtime: CliRuntime,
  options: AppOptions = {},
) {
  const token = 'test-launch-token';
  const app = createApp(runtime, { ...options, sessionToken: token });
  const request = app.request.bind(app);
  const session = options.publicMode
    ? Promise.resolve(undefined)
    : Promise.resolve(request(`http://127.0.0.1/?k=${token}`)).then(
        (response) => response.headers.get('set-cookie')?.split(';')[0],
      );
  app.request = async (input, init, ...rest) => {
    const cookie = await session;
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    if (cookie) headers.set('cookie', cookie);
    return input instanceof Request
      ? request(new Request(input, { ...init, headers }), undefined, ...rest)
      : request(input, { ...init, headers }, ...rest);
  };
  return app;
}
