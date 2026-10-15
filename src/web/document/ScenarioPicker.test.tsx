import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Scenario, ScenarioResponse } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { App } from '../App.js';
import { createMockApi } from '../mock-api.js';
import { ApiError } from '../sse.js';
import { MAX_SCENARIOS, ScenarioPicker } from './ScenarioPicker.js';

afterEach(cleanup);

const scenarioFor = (name: string): Scenario => ({
  subject: name,
  profile: {
    name,
    label: `Example ${name}`,
    illustrative: true,
    assumptions: [],
  },
  frames: (['setup', 'rule', 'effect'] as const).map((kind) => ({
    kind,
    avatar: 'person-a' as const,
    icon: 'house' as const,
    caption: `${kind} for ${name}`,
    citations: kind === 'rule' ? ['sec-4/b'] : [],
  })),
});

type Getter = ApiClient['getScenario'];

function setup(getScenario: Getter, personas = ['a renter', 'a voter']) {
  const api = { getScenario } as ApiClient;
  const onOpenSection = vi.fn();
  render(
    <ScenarioPicker
      api={api}
      docId="d"
      personas={personas}
      onOpenSection={onOpenSection}
    />,
  );
  return { onOpenSection };
}

const ok = (name: string): Promise<ScenarioResponse> =>
  Promise.resolve({ status: 'ok', scenario: scenarioFor(name) });

describe('ScenarioPicker', () => {
  test('renders the persona buttons and a labelled custom field limited to 80 characters', () => {
    setup(() => ok('x'));
    expect(
      screen.getByRole('heading', { name: 'How does this affect…?' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'a renter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'a voter' })).toBeTruthy();
    const input = screen.getByLabelText('Someone else…');
    expect(input.getAttribute('maxlength')).toBe('80');
  });

  test('works without suggestions: only the custom field is shown', () => {
    setup(() => ok('x'), []);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByLabelText('Someone else…')).toBeTruthy();
  });

  test('a persona click shows loading, then a strip named for the subject, with focus on its heading', async () => {
    let release: (r: ScenarioResponse) => void = () => undefined;
    const getScenario = vi.fn<Getter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    setup(getScenario);
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    expect(getScenario).toHaveBeenCalledWith(
      'd',
      { subject: 'a renter' },
      expect.any(AbortSignal),
    );
    // The visible line at once; the live region follows after its short clearing gap.
    await waitFor(() => {
      expect(
        screen.getAllByText(/Making an example for a renter…/).length,
      ).toBe(2);
    });
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    await act(async () => {
      release({ status: 'ok', scenario: scenarioFor('Sam') });
      await Promise.resolve();
    });
    const heading = await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText('Example · invented person')).toBeTruthy();
    expect(screen.queryByText(/Making an example for/)).toBeNull();
    expect(
      await screen.findByText('An example for a renter was added below.'),
    ).toBeTruthy();
  });

  test('citations in a generated strip open the source drawer callback', async () => {
    const { onOpenSection } = setup(() => ok('Sam'));
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Example source 1' }),
    );
    expect(onOpenSection).toHaveBeenCalledWith('sec-4/b', expect.anything());
  });

  test('a custom subject is trimmed, collapsed and sent on submit', async () => {
    const getScenario = vi.fn<Getter>(() => ok('Sam'));
    setup(getScenario);
    fireEvent.change(screen.getByLabelText('Someone else…'), {
      target: { value: '  a   student  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show an example' }));
    await screen.findByRole('heading', {
      name: 'What it could mean for a student',
    });
    expect(getScenario).toHaveBeenCalledWith(
      'd',
      { subject: 'a student' },
      expect.any(AbortSignal),
    );
  });

  test('an empty or blank custom subject sends nothing', () => {
    const getScenario = vi.fn<Getter>(() => ok('Sam'));
    setup(getScenario);
    const submit = screen.getByRole('button', { name: 'Show an example' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    fireEvent.change(screen.getByLabelText('Someone else…'), {
      target: { value: '   ' },
    });
    fireEvent.click(submit);
    expect(getScenario).not.toHaveBeenCalled();
  });

  test('a refused subject shows the server message inline, tied to the field, and clears on typing', async () => {
    const getScenario = vi.fn<Getter>(() =>
      Promise.reject(
        new ApiError('INVALID_INPUT', 'Describe who it is about, neutrally.'),
      ),
    );
    setup(getScenario);
    const input = screen.getByLabelText('Someone else…');
    fireEvent.change(input, { target: { value: 'unfair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show an example' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Describe who it is about, neutrally.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(screen.queryByText(/Making an example for/)).toBeNull();
    fireEvent.change(input, { target: { value: 'a renter' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an unexpected failure shows a plain message and the buttons work again', async () => {
    const getScenario = vi
      .fn<Getter>()
      .mockRejectedValueOnce(new Error('boom: secret detail'))
      .mockImplementation(() => ok('Sam'));
    setup(getScenario);
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a none result says the example could not be grounded', async () => {
    setup(() => Promise.resolve({ status: 'none' }));
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    expect(
      await screen.findByText(
        "Couldn't ground an example for a voter in this bill's text.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Example · invented person')).toBeNull();
  });

  test('an ok response with no scenario is treated like none', async () => {
    setup(() => Promise.resolve({ status: 'ok' }));
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    await screen.findByText(/Couldn't ground an example for a voter/);
  });

  test('does not send a second request for the same subject while one is pending', async () => {
    const releases: ((r: ScenarioResponse) => void)[] = [];
    const getScenario = vi.fn<Getter>(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    setup(getScenario);
    const button = screen.getByRole('button', { name: 'a renter' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Typing the same subject by hand is the same subject.
    fireEvent.change(screen.getByLabelText('Someone else…'), {
      target: { value: 'A  Renter' },
    });
    fireEvent.submit(screen.getByLabelText('Someone else…'));
    expect(getScenario).toHaveBeenCalledTimes(1);
    // A different subject is fine.
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    expect(getScenario).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const release of releases) release({ status: 'none' });
      await Promise.resolve();
    });
    // Once finished, asking again does not spend another call (see the next tests).
    await screen.findByText(/Couldn't ground an example for a renter/);
    fireEvent.click(button);
    expect(getScenario).toHaveBeenCalledTimes(2);
  });

  test(`keeps at most ${String(MAX_SCENARIOS)} strips, dropping the oldest`, async () => {
    setup(() => ok('Sam'));
    for (let i = 1; i <= MAX_SCENARIOS + 1; i++) {
      fireEvent.change(screen.getByLabelText('Someone else…'), {
        target: { value: `person ${String(i)}` },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Show an example' }));
      await screen.findByRole('heading', {
        name: `What it could mean for person ${String(i)}`,
      });
    }
    expect(screen.getAllByText('Example · invented person')).toHaveLength(
      MAX_SCENARIOS,
    );
    expect(
      screen.queryByRole('heading', {
        name: 'What it could mean for person 1',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'What it could mean for person 2' }),
    ).toBeTruthy();
  });

  test('a late reply does not take focus from the field the reader moved to', async () => {
    let release: (r: ScenarioResponse) => void = () => undefined;
    setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const button = screen.getByRole('button', { name: 'a renter' });
    button.focus();
    fireEvent.click(button);
    const input = screen.getByLabelText('Someone else…');
    input.focus();
    await act(async () => {
      release({ status: 'ok', scenario: scenarioFor('Sam') });
      await Promise.resolve();
    });
    await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    expect(document.activeElement).toBe(input);
  });

  test('focus still moves when it was left on the control that asked', async () => {
    setup(() => ok('Sam'));
    const button = screen.getByRole('button', { name: 'a renter' });
    button.focus();
    fireEvent.click(button);
    const heading = await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  test('unmounting aborts requests still in flight, and an abort is silent', async () => {
    let signal: AbortSignal | undefined;
    const getScenario = vi.fn<Getter>(
      (_d, _r, s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    setup(getScenario);
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    expect(signal?.aborted).toBe(false);
    cleanup();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed persona click is not reported on the custom field', async () => {
    setup(() => Promise.reject(new ApiError('NETWORK', 'Could not reach it.')));
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not reach it.');
    const input = screen.getByLabelText('Someone else…');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
    // It sits with the buttons, not inside the form.
    expect(alert.closest('form')).toBeNull();
  });

  test('asking again for a finished subject shows the existing strip instead of a new call', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const getScenario = vi.fn<Getter>(() => ok('Sam'));
    setup(getScenario);
    const button = screen.getByRole('button', { name: 'a renter' });
    fireEvent.click(button);
    const heading = await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    await screen.findByRole('heading', {
      name: 'What it could mean for a voter',
    });
    expect(document.activeElement).not.toBe(heading);
    // Same subject typed differently counts as the same.
    fireEvent.change(screen.getByLabelText('Someone else…'), {
      target: { value: 'A  Renter' },
    });
    fireEvent.submit(screen.getByLabelText('Someone else…'));
    expect(getScenario).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalled();
    expect(screen.getAllByText('Example · invented person')).toHaveLength(2);
    await screen.findByText('An example for a renter is already shown below.');
  });

  test('asking again for a subject with no example focuses that note', async () => {
    const getScenario = vi.fn<Getter>(() =>
      Promise.resolve({ status: 'none' }),
    );
    setup(getScenario);
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    const note = (
      await screen.findByText(/Couldn't ground an example for a voter/)
    ).parentElement;
    fireEvent.click(screen.getByRole('button', { name: 'a voter' }));
    expect(getScenario).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(note);
  });

  test('a repeated announcement is cleared first so it is read again', async () => {
    setup(() => ok('Sam'));
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    const live = () => document.querySelector('p[aria-live="polite"]')!;
    await waitFor(() => {
      expect(live().textContent).toBe(
        'An example for a renter was added below.',
      );
    });
    // Same sentence again (the strip is already there, so the "already shown" message differs).
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    expect(live().textContent).toBe('');
    await waitFor(() => {
      expect(live().textContent).toBe(
        'An example for a renter is already shown below.',
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    expect(live().textContent).toBe('');
    await waitFor(() => {
      expect(live().textContent).toBe(
        'An example for a renter is already shown below.',
      );
    });
  });

  test('a reply that arrives after unmount is ignored', async () => {
    let release: (r: ScenarioResponse) => void = () => undefined;
    const getScenario = vi.fn<Getter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    setup(getScenario);
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    cleanup();
    await act(async () => {
      release({ status: 'ok', scenario: scenarioFor('Sam') });
      await Promise.resolve();
    });
    expect(screen.queryByText('Example · invented person')).toBeNull();
  });
});

describe('in the document screen', () => {
  const mock = (publicMode: boolean) =>
    createMockApi({ delayMs: 0, publicMode });
  const ready = () =>
    screen.findByRole('heading', { name: 'Clean Water Infrastructure Act' });

  test('the section sits under the summary with the sample document personas', async () => {
    render(<App api={mock(false)} />);
    await ready();
    await screen.findByRole('heading', { name: 'How does this affect…?' });
    fireEvent.click(screen.getByRole('button', { name: 'a renter' }));
    await screen.findByRole('heading', {
      name: 'What it could mean for a renter',
    });
    // The default strip from the summary is still there, separate from the new one.
    await waitFor(
      () => {
        expect(
          screen.getByRole('region', { name: /What it could mean for Sam/ }),
        ).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  test('the mock persona with no grounded example shows the empty state', async () => {
    render(<App api={mock(false)} />);
    await ready();
    fireEvent.click(
      await screen.findByRole('button', { name: 'a non-resident' }),
    );
    await screen.findByText(/Couldn't ground an example for a non-resident/);
  });

  test('a judging custom subject is refused inline by the mock, as the server does', async () => {
    render(<App api={mock(false)} />);
    await ready();
    fireEvent.change(await screen.findByLabelText('Someone else…'), {
      target: { value: 'an unfair burden' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show an example' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/neutral/);
  });

  test('hidden in public mode', async () => {
    render(<App api={mock(true)} />);
    await ready();
    expect(
      screen.queryByRole('heading', { name: 'How does this affect…?' }),
    ).toBeNull();
    expect(screen.queryByLabelText('Someone else…')).toBeNull();
  });

  test('hidden when scenarios are switched off in the config', async () => {
    const api = mock(false);
    const real = api.getConfig.bind(api);
    api.getConfig = async () => ({
      ...(await real()),
      scenariosEnabled: false,
    });
    render(<App api={api} />);
    await ready();
    expect(screen.queryByLabelText('Someone else…')).toBeNull();
  });
});
