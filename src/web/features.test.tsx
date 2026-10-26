// The rc.2 regions of the bill view, driven through the scripted mock API: summary on arrival,
// scenario strip, sponsor byline, history card and the server-not-running card.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { SAMPLE_PATH, visit } from '../../tests/support/web-routes.js';
import { App } from './App.js';
import type { ApiClient } from './api.js';
import { createMockApi } from './mock-api.js';
import { SponsorList, pickSponsorLink } from './document/SponsorList.js';
import { SummaryPanel } from './document/SummaryPanel.js';
import { ScenarioStrip } from './document/ScenarioStrip.js';
import { AVATAR_ICONS, TOPIC_ICONS } from './document/scenario-icons.js';
import { AvatarId, IconId } from '../core/model/index.js';
import type { Scenario, SponsorLink } from '../core/model/index.js';
import { ApiError } from './sse.js';

beforeEach(() => {
  // These suites exercise an open document; the homepage has its own tests.
  visit(SAMPLE_PATH);
});
afterEach(cleanup);

const mock = (publicMode = false): ApiClient =>
  createMockApi({ delayMs: 0, publicMode });

async function ready() {
  await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
}

async function sampleDetail(api: ApiClient) {
  const [doc] = await api.listDocs();
  return { doc: doc!, detail: await api.getDoc(doc!.docId) };
}

describe('summary on arrival', () => {
  test('shows the preview, then the cached summary once polling finds it', async () => {
    const api = mock();
    const { doc, detail } = await sampleDetail(api);
    render(
      <SummaryPanel
        api={api}
        docId={doc.docId}
        preview={detail.preview}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={5}
      />,
    );
    // Instantly: the purpose line and a quiet progress note, never an empty card.
    expect(screen.getByText(/To require water utilities/)).toBeTruthy();
    expect(screen.getByText('Writing a plain-language summary…')).toBeTruthy();
    // Then the cached answer replaces it, with citation buttons of its own name.
    await screen.findByRole('button', { name: 'Summary source 1' });
    expect(screen.queryByText('Writing a plain-language summary…')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('the whole page keeps a single role=status while the summary arrives', async () => {
    render(<App api={mock()} />);
    await ready();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'In brief' })).toBeTruthy();
  });

  test('gives up politely after the maximum wait', async () => {
    const api = mock();
    api.getSummary = () => Promise.resolve({ status: 'pending' });
    const { doc, detail } = await sampleDetail(api);
    render(
      <SummaryPanel
        api={api}
        docId={doc.docId}
        preview={detail.preview}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={5}
        maxWaitMs={30}
      />,
    );
    await screen.findByText(/taking longer than expected/);
    expect(screen.getByText(/Summarize this bill/)).toBeTruthy();
    expect(screen.getByText(/To require water utilities/)).toBeTruthy();
  });

  test('disabled shows only the preview and points at the chip', async () => {
    const api = mock();
    api.getSummary = () => Promise.resolve({ status: 'disabled' });
    const { doc, detail } = await sampleDetail(api);
    const props = {
      api,
      docId: doc.docId,
      preview: detail.preview,
      officialSummary: undefined,
      onOpenSection: () => undefined,
    };
    const { unmount } = render(<SummaryPanel {...props} publicMode={false} />);
    await screen.findByText("Choose 'Summarize this bill' for a full summary.");
    expect(screen.getByText(/To require water utilities/)).toBeTruthy();
    unmount();
    // In public mode there is no chip to point to.
    render(<SummaryPanel {...props} publicMode />);
    await waitFor(() => {
      expect(screen.queryByText(/Writing a plain-language/)).toBeNull();
    });
    expect(screen.queryByText(/Choose 'Summarize/)).toBeNull();
  });

  test('a failed summary call keeps the preview and says so', async () => {
    const api = mock();
    api.getSummary = () => Promise.reject(new ApiError('X', 'Nope.'));
    const { doc, detail } = await sampleDetail(api);
    render(
      <SummaryPanel
        api={api}
        docId={doc.docId}
        preview={detail.preview}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={5}
        maxWaitMs={30}
      />,
    );
    await screen.findByText('The summary could not be loaded right now.');
    expect(screen.queryByText(/Nope/)).toBeNull();
    expect(screen.getByText(/To require water utilities/)).toBeTruthy();
  });

  test('the official summary is a collapsed disclosure of plain text with its source link', async () => {
    render(<App api={mock()} />);
    await ready();
    const summary = await screen.findByText(
      'Official summary (Congressional Research Service)',
    );
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/requires water utilities/)).toBeTruthy();
    const link = within(details).getByRole('link');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('scenario strip', () => {
  test('a transient poll failure is retried and the summary still arrives', async () => {
    const api = mock();
    const real = api.getSummary.bind(api);
    let calls = 0;
    api.getSummary = (id) =>
      ++calls === 1 ? Promise.reject(new ApiError('X', 'blip')) : real(id);
    const { doc, detail } = await sampleDetail(api);
    render(
      <SummaryPanel
        api={api}
        docId={doc.docId}
        preview={detail.preview}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={5}
      />,
    );
    await screen.findByRole('button', { name: 'Summary source 1' });
    expect(
      screen.getByText('An example was added below.').getAttribute('aria-live'),
    ).toBe('polite');
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  test('appears from the cached summary and opens the citation drawer', async () => {
    render(<App api={mock()} />);
    await ready();
    const strip = await screen.findByRole(
      'region',
      { name: /What it could mean for Sam/ },
      { timeout: 4000 },
    );
    expect(within(strip).getByText('Example · invented person')).toBeTruthy();
    expect(
      within(strip).getByText(
        'Sam is made up. What the bill requires comes from the sections cited.',
      ),
    ).toBeTruthy();
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(
      within(strip).getAllByRole('button', { name: 'Example source 1' })[0]!,
    );
    await screen.findByRole('dialog', { name: 'Source text' });
  });

  test('arrives after done on the ask stream and attaches to that answer', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Who does it affect?' }),
    );
    const answer = screen.getByRole('region', { name: 'Answer' });
    await within(answer).findByRole('region', {
      name: /What it could mean for Sam/,
    });
  });

  test('captions are text, never markup', () => {
    const scenario: Scenario = {
      subject: 's',
      profile: { name: 'Pat', label: 'x', illustrative: true, assumptions: [] },
      frames: (['setup', 'rule', 'effect'] as const).map((kind) => ({
        kind,
        avatar: 'worker' as const,
        icon: 'gun' as const,
        caption: '<img src=x onerror=alert(1)> <b>bold</b>',
        citations: [],
      })),
    };
    const { container } = render(
      <ScenarioStrip scenario={scenario} onOpenSection={() => undefined} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getAllByText(/<b>bold<\/b>/)).toHaveLength(3);
  });

  test('every avatar and icon id has a glyph', () => {
    for (const id of AvatarId.options) expect(AVATAR_ICONS[id]).toBeTruthy();
    for (const id of IconId.options) expect(TOPIC_ICONS[id]).toBeTruthy();
  });
});

describe('sponsor byline', () => {
  test('links the verified page and labels search-only sponsors as searches', async () => {
    render(<App api={mock()} />);
    await ready();
    const rivera = screen.getByRole('link', { name: /Rep. A. Rivera/ });
    expect(rivera.getAttribute('href')).toBe('https://rivera.house.gov/');
    expect(rivera.textContent).toContain('official page');
    expect(rivera.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rivera.getAttribute('target')).toBe('_blank');
    const chen = screen.getByRole('link', { name: /Rep. J. Chen/ });
    expect(chen.textContent).toContain('search Ballotpedia');
    // Cosponsors sit behind a disclosure.
    expect(screen.getByText('and 1 cosponsor').closest('details')!.open).toBe(
      false,
    );
  });

  test('prefers official, then Wikipedia, Ballotpedia, legislature', () => {
    const l = (kind: SponsorLink['kind'], verified = true): SponsorLink => ({
      kind,
      url: `https://${kind}.example/`,
      label: kind,
      verified,
    });
    expect(
      pickSponsorLink([l('legislature'), l('ballotpedia'), l('wikipedia')])
        ?.label,
    ).toBe('Wikipedia');
    expect(pickSponsorLink([l('legislature'), l('official')])?.label).toBe(
      'official page',
    );
    expect(pickSponsorLink([l('legislature')])?.label).toBe('legislature page');
    expect(pickSponsorLink([])).toBeNull();
  });

  test('falls back to plain names without profiles', () => {
    const { container } = render(
      <SponsorList names={['A. One', 'B. Two']} profiles={undefined} />,
    );
    expect(container.textContent).toBe('A. One, B. Two');
  });
});

describe('history card', () => {
  test('lists versions and actions oldest first, amendments, the note and the full-story chip', async () => {
    render(<App api={mock()} />);
    await ready();
    const card = screen.getByRole('region', { name: 'How did it get here?' });
    expect(within(card).getByText('Introduced in House')).toBeTruthy();
    expect(within(card).getByText('Reported in House')).toBeTruthy();
    expect(within(card).getByText(/Amendment 1 by Rep. J. Chen/)).toBeTruthy();
    expect(
      within(card).getByText(
        'From the official record. People are named only when the record names them.',
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(card).getByRole('button', { name: 'The full story' }),
    );
    const answer = screen.getByRole('region', { name: 'Answer' });
    await within(answer).findByText(/official record says/);
  });

  test('says plainly when no history is available', async () => {
    const api = mock();
    const real = api.getDoc.bind(api);
    api.getDoc = async (id) => {
      const { history: _dropped, ...rest } = await real(id);
      return rest;
    };
    render(<App api={api} />);
    await ready();
    const card = screen.getByRole('region', { name: 'How did it get here?' });
    expect(within(card).getByText(/not available/)).toBeTruthy();
  });
});

describe('server-unreachable state', () => {
  test('replaces the error cascade with one friendly card and a working Retry', async () => {
    const api = mock();
    let up = false;
    const config = api.getConfig.bind(api);
    api.getConfig = () =>
      up
        ? config()
        : Promise.reject(
            new ApiError('NETWORK', 'Could not reach the server.'),
          );
    render(<App api={api} />);
    const card = await screen.findByRole('region', {
      name: /can't reach its server/,
    });
    expect(card.textContent).toContain(`npx ${BRAND.name} serve`);
    expect(screen.queryByRole('alert')).toBeNull();
    up = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    await ready();
    expect(screen.queryByText(/reach its server/)).toBeNull();
  });

  test('also covers a failed document list', async () => {
    const api = mock();
    api.listDocs = () => Promise.reject(new ApiError('NETWORK', 'down'));
    render(<App api={api} />);
    await screen.findByRole('button', { name: 'Retry' });
  });
});
