import { SaxesParser } from 'saxes';
import { load } from 'cheerio';
import { MAX_NAME, MAX_TEXT, sanitizeText, stripInvisible } from './text.js';
import { AppError, BillHistory, SponsorProfile } from '../model/index.js';
import {
  govinfoTextUrl,
  resolveGovinfo,
  type GovinfoPlan,
  type HistoryRecord,
} from './resolve.js';

interface Element {
  name: string;
  children: Element[];
  parts: (Element | string)[];
}

/** Saxes never loads a DTD or expands external entities. Bound depth before building the tree. */
function xmlTree(bytes: Uint8Array): Element {
  const parser = new SaxesParser({ xmlns: false });
  const stack: Element[] = [];
  let root: Element | undefined;
  parser.on('error', () => {
    throw new AppError('PARSE_FAILED');
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= 128) throw new AppError('PARSE_FAILED');
    const element: Element = {
      name: tag.name.split(':').at(-1) ?? tag.name,
      children: [],
      parts: [],
    };
    stack.at(-1)?.children.push(element);
    stack.at(-1)?.parts.push(element);
    root ??= element;
    stack.push(element);
  });
  const text = (value: string) => {
    stack.at(-1)?.parts.push(value);
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser
      .write(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      .close();
  } catch {
    throw new AppError('PARSE_FAILED');
  }
  if (root?.name !== 'billStatus') throw new AppError('PARSE_FAILED');
  return root;
}

const child = (
  element: Element | undefined,
  name: string,
): Element | undefined => element?.children.find((item) => item.name === name);
function content(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  const text = element.parts
    .map((part) =>
      typeof part === 'string' ? part : ` ${content(part) ?? ''} `,
    )
    .join('');
  // The byte order mark counts as `\s`: remove invisibles before collapsing whitespace, or it
  // would turn into a word break.
  const collapsed = stripInvisible(text).replace(/\s+/g, ' ').trim();
  return collapsed || undefined;
}
const field = (
  element: Element | undefined,
  name: string,
): string | undefined => content(child(element, name));

/** CRS summaries run longer than an action line; still bounded so one record cannot bloat history. */
const MAX_SUMMARY = 10_000;

/**
 * BILLSTATUS text is untrusted: it ends up in prompts and in the UI. HTML is reduced to text
 * (dropping script and style bodies, which `sanitizeText` alone would keep as words), then the
 * shared history sanitizer removes control, zero-width and bidi characters, markup that survived
 * entity decoding, and caps the length, exactly as for the Ohio adapter.
 */
function plainText(
  value: string | undefined,
  max: number = MAX_TEXT,
): string | undefined {
  if (!value) return undefined;
  // CDATA can retain an extra HTML-escape layer that ordinary XML text has already decoded.
  if (/^&lt;[a-z][\s\S]*?&gt;/i.test(value)) {
    value = load(value, null, false).root().text();
  }
  const $ = load(value, null, false);
  $('script,style').remove();
  $('p,li,br,div,ul,ol,h1,h2,h3,h4,h5,h6,tr,td,th').before(' ');
  return sanitizeText($.root().text(), max) || undefined;
}

const textField = (
  element: Element | undefined,
  name: string,
  max: number = MAX_TEXT,
): string | undefined => plainText(field(element, name), max);
/** Short identifying text: names, parties, labels, committee names. */
const nameField = (
  element: Element | undefined,
  name: string,
): string | undefined => textField(element, name, MAX_NAME);

const items = (element: Element | undefined): Element[] =>
  element?.children.filter(
    (item) => item.name === 'item' || item.name === 'amendment',
  ) ?? [];

function committeeName(element: Element): string | undefined {
  return (
    nameField(child(element, 'committee'), 'name') ??
    nameField(items(child(element, 'committees'))[0], 'name')
  );
}

function date(value: string | undefined): string | undefined {
  return value &&
    /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
function chamber(value: string | undefined): SponsorProfile['chamber'] {
  const normalized = value?.toLowerCase();
  return normalized === 'house' || normalized === 'senate'
    ? normalized
    : undefined;
}

function member(
  element: Element,
  role: SponsorProfile['role'],
): SponsorProfile | undefined {
  const name =
    nameField(element, 'fullName') ??
    [
      nameField(element, 'firstName'),
      nameField(element, 'middleName'),
      nameField(element, 'lastName'),
    ]
      .filter(Boolean)
      .join(' ');
  if (!name) return undefined;
  return SponsorProfile.parse({
    name,
    role,
    links: [],
    party: nameField(element, 'party'),
    state: nameField(element, 'state'),
    district: nameField(element, 'district'),
    chamber:
      chamber(nameField(element, 'chamber')) ??
      (name.startsWith('Rep.')
        ? 'house'
        : name.startsWith('Sen.')
          ? 'senate'
          : undefined),
    bioguideId:
      field(element, 'bioguideId') ??
      field(child(element, 'identifiers'), 'bioguideId'),
  });
}

/**
 * The enacted Public Law is not a bill text version (its package is PLAW-..., not BILLS-...),
 * and it must not stand in for or hide the latest bill text, so it is left out of versions.
 */
function isPublicLaw(element: Element): boolean {
  return (
    nameField(element, 'type')?.toLowerCase() === 'public law' ||
    items(child(element, 'formats')).some((format) =>
      /\/PLAW-[^/]*\/|\/PLAW-[^/]*$/.test(field(format, 'url') ?? ''),
    )
  );
}

function version(
  element: Element,
  plan: GovinfoPlan,
): BillHistory['versions'][number] {
  // Only a code from a matching anchored package is retained; the XML URL is never followed.
  for (const format of items(child(element, 'formats'))) {
    const url = field(format, 'url');
    if (!url) continue;
    let linked: GovinfoPlan | undefined;
    try {
      linked = resolveGovinfo(new URL(url));
    } catch {
      continue;
    }
    if (
      !linked?.version ||
      linked.congress !== plan.congress ||
      linked.type !== plan.type ||
      linked.number !== plan.number
    )
      continue;
    return {
      code: linked.version,
      label: nameField(element, 'type') ?? linked.version,
      date: date(field(element, 'date')),
      url: govinfoTextUrl(plan, linked.version),
    };
  }
  // Keep an unresolvable bill-text entry (empty code) so latest selection fails loudly
  // instead of silently choosing an older text.
  return {
    code: '',
    label: nameField(element, 'type') ?? 'Version unavailable',
    date: date(field(element, 'date')),
  };
}

function amendmentStatus(
  element: Element,
): BillHistory['amendments'][number]['status'] {
  const explicit = field(element, 'status')?.toLowerCase();
  if (
    explicit === 'adopted' ||
    explicit === 'offered' ||
    explicit === 'rejected' ||
    explicit === 'withdrawn'
  )
    return explicit;
  const text = textField(child(element, 'latestAction'), 'text') ?? '';
  // Do not mistake a vote on a motion (e.g. to table) for a decision on the amendment.
  const namesAmendment =
    /^(?:Proposed )?Amendment\b/i.test(text) ||
    /^On agreeing to\b.*\bamendments?\b/i.test(text);
  if (!namesAmendment || /\bmotion\b/i.test(text)) return 'unknown';
  if (/\b(?:not agreed to|rejected|not adopted|failed)\b/i.test(text))
    return 'rejected';
  if (/\b(?:agreed to|adopted)\b/i.test(text)) return 'adopted';
  if (/\bwithdrawn\b/i.test(text)) return 'withdrawn';
  if (/\b(?:offered|submitted|proposed)\b/i.test(text)) return 'offered';
  return 'unknown';
}

function amendment(
  element: Element,
): BillHistory['amendments'][number] | undefined {
  const number = nameField(element, 'number');
  const congress = nameField(element, 'congress');
  const type = nameField(element, 'type');
  if (!number || !congress || !type) return undefined;
  const sponsorElement =
    child(element, 'sponsor') ?? items(child(element, 'sponsors'))[0];
  const sponsor = sponsorElement
    ? member(sponsorElement, 'sponsor')
    : undefined;
  return {
    id: `${congress}${type.toLowerCase()}${number}`,
    number,
    status: amendmentStatus(element),
    sponsor: sponsor
      ? { name: sponsor.name, bioguideId: sponsor.bioguideId }
      : undefined,
    purpose: textField(element, 'purpose'),
    description: textField(element, 'description'),
    committee: committeeName(element),
    date: date(field(child(element, 'latestAction'), 'actionDate')),
  };
}

/**
 * The bill's official title, which `parseXml` drops in favour of the short title. Prefer the
 * introduced wording (it states the purpose), else any official title; never a short title.
 */
function officialTitle(bill: Element): string | undefined {
  const titles = items(child(bill, 'titles')).map((item) => ({
    type: nameField(item, 'titleType') ?? '',
    text: textField(item, 'title'),
  }));
  const official = titles.filter(
    (title) => title.text && /^official title\b/i.test(title.type),
  );
  return (
    official.find((title) => /as introduced/i.test(title.type)) ?? official[0]
  )?.text;
}

/**
 * Parse official-record fields as plain text and validate against the frozen schemas.
 * Consumers must render output as text and quote it as untrusted data in prompts;
 * HTML stripping does not make upstream wording or literal angle brackets trusted.
 */
export function parseGovinfoBillStatus(
  bytes: Uint8Array,
  plan: GovinfoPlan,
  fetchedAt: string,
): HistoryRecord {
  const bill = child(xmlTree(bytes), 'bill');
  const type = (field(bill, 'type') ?? field(bill, 'billType'))?.toLowerCase();
  if (
    !bill ||
    Number(field(bill, 'congress')) !== plan.congress ||
    Number(field(bill, 'number') ?? field(bill, 'billNumber')) !==
      plan.number ||
    (type === 'h' ? 'hr' : type) !== plan.type
  )
    throw new AppError('PARSE_FAILED');
  const sponsorProfiles = [
    ...items(child(bill, 'sponsors')).map((item) => member(item, 'sponsor')),
    ...items(child(bill, 'cosponsors')).map((item) =>
      member(item, 'cosponsor'),
    ),
  ].filter((item) => item !== undefined);
  const summaries =
    child(child(bill, 'summaries'), 'billSummaries') ??
    child(bill, 'summaries');
  const summaryText = (item: Element): string | undefined =>
    textField(child(item, 'cdata'), 'text', MAX_SUMMARY) ??
    textField(item, 'text', MAX_SUMMARY);
  const summary = (
    summaries?.children.filter(
      (item) => item.name === 'summary' || item.name === 'item',
    ) ?? []
  )
    .map((item) => ({ item, text: summaryText(item) }))
    .filter((summary) => summary.text)
    .sort(
      (a, b) =>
        (date(field(b.item, 'actionDate')) ?? '').localeCompare(
          date(field(a.item, 'actionDate')) ?? '',
        ) ||
        (date(field(b.item, 'updateDate')) ?? '').localeCompare(
          date(field(a.item, 'updateDate')) ?? '',
        ),
    )[0];
  let officialSummary: BillHistory['officialSummary'];
  if (summary?.text) {
    officialSummary = {
      text: summary.text,
      source: 'Congressional Research Service',
      url: plan.billStatusUrl,
      date: date(field(summary.item, 'actionDate')),
    };
  }
  const history = BillHistory.parse({
    officialSummary,
    // Stored versions are oldest first. BILLSTATUS lists them newest first, so reverse.
    versions: items(child(bill, 'textVersions'))
      .filter((item) => !isPublicLaw(item))
      .map((item) => version(item, plan))
      .reverse(),
    actions: items(child(bill, 'actions')).flatMap((item) => {
      const actionDate = date(field(item, 'actionDate'));
      const text = textField(item, 'text');
      if (!actionDate || !text) return [];
      const systemName = nameField(child(item, 'sourceSystem'), 'name');
      return [
        {
          date: actionDate,
          text,
          committee: committeeName(item),
          chamber:
            nameField(item, 'chamber') ??
            (systemName === 'House' || systemName === 'Senate'
              ? systemName
              : undefined),
        },
      ];
    }),
    amendments: items(child(bill, 'amendments'))
      .map(amendment)
      .filter((item) => item !== undefined),
    sources: [{ host: 'www.govinfo.gov', url: plan.billStatusUrl, fetchedAt }],
  });
  const title = officialTitle(bill);
  return {
    history,
    sponsorProfiles,
    ...(title ? { officialTitle: title } : {}),
  };
}
