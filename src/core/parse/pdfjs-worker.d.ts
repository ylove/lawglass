// PDF.js ships no declarations for its worker module. The parser only hands the module to
// PDF.js (as globalThis.pdfjsWorker) so the worker runs on this thread; see pdf.ts.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
