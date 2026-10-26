/**
 * Structured replies the mock provider gives for the features that need a real-looking object
 * (section briefs, pictures, "Find where it says that", a part's example). They exist so the
 * packed app can be driven end to end without a model. Each reply is built only from what the
 * prompt contains, in the same spirit as the mock's text answers, and passes the same checks a
 * real model's reply must pass. Anything not handled here falls back to the mock's empty object.
 */
import { messageText, type ObjectRequest } from '../model/index.js';

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const unescapeText = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** One brief per listed part, citing the part's own section. Definitions have no example. */
function sectionBriefs(prompt: string): unknown {
  const parts = [...prompt.matchAll(/^- id (\S+): ([^<\n]*)/gm)];
  return {
    briefs: parts.map(([, id = '', label = '']) => ({
      id,
      text: `This part covers ${label}. [S:${id}]`,
      example: /definition/i.test(label) ? 'none' : 'available',
    })),
  };
}

/**
 * One plain panel per item that says something to draw. A lead-in such as "In this Act:" is
 * skipped, as the real prompt tells the model to skip what cannot be drawn honestly, which also
 * leaves one bullet without a picture for the tests to look at. No labels, so nothing needs
 * checking against the item's words.
 */
function pictures(prompt: string): unknown {
  const items = [...prompt.matchAll(/<item n="(\d+)">([\s\S]*?)<\/item>/g)];
  return {
    pictures: items
      .filter(([, , text = '']) => !/^\s*in this act/i.test(text))
      .map(([, n = '0']) => ({
        item: Number(n),
        panels: [
          {
            left: { glyphs: ['people'] },
            link: 'none',
            stamp: { glyph: 'check' },
          },
        ],
      })),
  };
}

/**
 * Quote the reader's sentence from the first candidate that contains it word for word; if none
 * does, say it was not found. The real selection rules (verbatim quote, cited explanation) are
 * checked afterwards by `verifySelection`, exactly as for a model.
 */
function locate(prompt: string): unknown {
  const sentence = squash(
    unescapeText(/<sentence>([\s\S]*?)<\/sentence>/.exec(prompt)?.[1] ?? ''),
  );
  const candidates = /<candidates>([\s\S]*?)<\/candidates>/.exec(prompt)?.[1];
  for (const [, tag = '', body = ''] of (candidates ?? '').matchAll(
    /<(?:excerpt|part)( [^>]*)>([\s\S]*?)<\/(?:excerpt|part)>/g,
  )) {
    const text = squash(unescapeText(body));
    const at = text.toLowerCase().indexOf(sentence.toLowerCase());
    if (!sentence || at < 0) continue;
    return {
      matches: [
        {
          passage: Number(attr(tag, 'id')),
          quote: text.slice(at, at + sentence.length),
          explanation: `The bill says this in its own words. [S:${attr(tag, 'section') ?? ''}]`,
        },
      ],
      notFound: false,
    };
  }
  return { matches: [], notFound: true };
}

/**
 * A three-step example for one part of the bill (the prompt carries a `<focus>`). Answers to
 * ordinary questions carry no focus and keep getting the empty object, so no story is attached
 * to them. The person is the one the app chose; the steps only restate the cited section.
 */
function partExample(prompt: string): unknown {
  if (!prompt.includes('<focus>')) return undefined;
  const name = /<persona>([^<]+)<\/persona>/.exec(prompt)?.[1] ?? 'Alex';
  const section = /<(?:excerpt|part) [^>]*\bsection="([^"]+)"/.exec(
    prompt,
  )?.[1];
  if (!section) return undefined;
  const label = 'Example resident';
  return {
    subject: 'Garden grants',
    profile: { name, label, illustrative: true, assumptions: [] },
    frames: [
      {
        kind: 'setup',
        avatar: 'person-a',
        icon: 'job',
        caption: `This is ${name}. ${label}.`,
        citations: [],
      },
      {
        kind: 'rule',
        avatar: 'person-a',
        icon: 'document',
        caption: `${name} reads the rule for this part.`,
        citations: [section],
      },
      {
        kind: 'effect',
        avatar: 'person-a',
        icon: 'calendar',
        caption: `The rule applies to ${name} as written.`,
        citations: [section],
      },
    ],
  };
}

/** The scripted reply for this request, or undefined to let the mock return its empty object. */
export function mockObject(req: ObjectRequest<unknown>): unknown {
  const prompt = messageText(req.prompt);
  switch (req.schemaName) {
    case 'section_briefs':
      return sectionBriefs(prompt);
    case 'pictures':
      return pictures(prompt);
    case 'locate':
      return locate(prompt);
    case 'scenario':
      return partExample(prompt);
    default:
      return undefined;
  }
}
