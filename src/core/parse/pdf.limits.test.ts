import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BRAND } from '../brand.js';
import { parsePdf } from './pdf.js';

const fake = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getTextContent: vi.fn(),
  cleanup: vi.fn(),
  destroy: vi.fn(),
  workerDestroy: vi.fn(),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs', () => ({}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  PDFWorker: class {
    destroy = fake.workerDestroy;
  },
  PasswordException: class extends Error {},
  getDocument: fake.getDocument,
  OPS: {},
  AnnotationMode: { DISABLE: 0 },
  VerbosityLevel: { ERRORS: 0 },
}));
const options = {
  sourceUrl: 'https://example.gov/bill.pdf',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

beforeEach(() => {
  fake.getTextContent.mockResolvedValue({
    items: [
      {
        str: 'Section 1. The board shall adopt rules for the program by June.',
        width: 300,
        fontName: 'F1',
        transform: [12, 0, 0, 12, 70, 700],
      },
    ],
  });
  fake.getPage.mockResolvedValue({
    getTextContent: fake.getTextContent,
    getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
    getAnnotations: () => Promise.resolve([]),
    view: [0, 0, 612, 792],
    cleanup: fake.cleanup,
  });
  fake.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 3, getPage: fake.getPage }),
    destroy: fake.destroy,
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('checks page count before requesting or extracting any page and releases PDF resources', async () => {
  await expect(
    parsePdf(new Uint8Array([1]), { ...options, maxPages: 2 }),
  ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(fake.getPage).not.toHaveBeenCalled();
  expect(fake.getTextContent).not.toHaveBeenCalled();
  expect(fake.destroy).toHaveBeenCalledOnce();
  expect(fake.workerDestroy).toHaveBeenCalledOnce();
});

it('uses the configurable local cap and accepts exactly the cap', async () => {
  vi.stubEnv(`${BRAND.envPrefix}_MAX_PAGES`, '2');
  await expect(parsePdf(new Uint8Array([1]), options)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(fake.getPage).not.toHaveBeenCalled();
  const doc = await parsePdf(new Uint8Array([1]), { ...options, maxPages: 3 });
  expect(doc.pageCount).toBe(3);
  expect(fake.getDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({
      maxImageSize: 40_000_000,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    }),
  );
});

it('stops during first-page extraction on abort and cleans up', async () => {
  const controller = new AbortController();
  fake.getTextContent.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve({ items: [] });
  });
  await expect(
    parsePdf(new Uint8Array([1]), { ...options, signal: controller.signal }),
  ).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: expect.stringContaining('cancelled') as unknown,
  });
  expect(fake.getPage).toHaveBeenCalledOnce();
  expect(fake.cleanup).toHaveBeenCalledOnce();
  expect(fake.destroy).toHaveBeenCalledOnce();
});

it('stops on a time budget exceeded mid-page without requesting the next page', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  fake.getTextContent.mockImplementationOnce(() => {
    clock.mockReturnValue(11);
    return Promise.resolve({ items: [] });
  });
  await expect(
    parsePdf(new Uint8Array([1]), { ...options, timeoutMs: 10 }),
  ).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: expect.stringContaining('too long') as unknown,
  });
  expect(fake.getPage).toHaveBeenCalledOnce();
  expect(fake.destroy).toHaveBeenCalledOnce();
});

it('cancels a stalled document-loading task', async () => {
  fake.getDocument.mockReturnValueOnce({
    promise: new Promise<never>(() => {
      /* Deliberately stalled work. */
    }),
    destroy: fake.destroy,
  });
  await expect(
    parsePdf(new Uint8Array([1]), { ...options, timeoutMs: 10 }),
  ).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: expect.stringContaining('too long') as unknown,
  });
  expect(fake.destroy).toHaveBeenCalledOnce();
  expect(fake.getPage).not.toHaveBeenCalled();
});

it('lets external cancellation events run between pages', async () => {
  const controller = new AbortController();
  const content = (await fake.getTextContent()) as unknown;
  fake.getTextContent.mockClear();
  fake.getTextContent.mockImplementationOnce(() => {
    setImmediate(() => {
      controller.abort();
    });
    return Promise.resolve(content);
  });
  await expect(
    parsePdf(new Uint8Array([1]), { ...options, signal: controller.signal }),
  ).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: 'Document parsing was cancelled.',
  });
  expect(fake.getPage).toHaveBeenCalledOnce();
  expect(fake.cleanup).toHaveBeenCalledOnce();
});
