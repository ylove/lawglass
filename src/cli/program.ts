// CLI command definitions. Each command is a thin wrapper over the shared pipeline.
import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND } from '../core/brand.js';
import { initConfig } from '../core/config.js';
import { AppError, ChipId } from '../core/model/index.js';
import { ask, ingest } from '../core/pipeline/index.js';
import { formatAskFooter, formatIngest, formatList } from './format.js';
import {
  createRuntime,
  type CliRuntime,
  type RuntimeFactory,
} from './runtime.js';
import { promptChoice, promptSecret } from './secret-prompt.js';

function notImplemented(issue: number): () => void {
  return () => {
    console.log(`not implemented yet (see issue #${String(issue)})`);
    process.exitCode = 2;
  };
}

export interface CliDependencies {
  init?: (options: { force: boolean }) => Promise<unknown>;
  runtime?: RuntimeFactory;
  /** Where command output goes. Default: process.stdout. */
  write?: (text: string) => void;
  /** Start the local server and open the browser (issue #29). Absent until it lands. */
  serve?: (runtime: CliRuntime, docId: string) => Promise<void>;
}

interface BackendOption {
  backend?: string;
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const write =
    dependencies.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const open = (
    options: BackendOption,
    needsLlm: boolean,
  ): Promise<CliRuntime> =>
    (dependencies.runtime ?? createRuntime)({
      backend: options.backend,
      needsLlm,
    });

  async function ingestUrl(
    url: string,
    options: BackendOption & { name?: string },
  ): Promise<{ runtime: CliRuntime; docId: string }> {
    const runtime = await open(options, true);
    try {
      const result = await ingest(
        url,
        {
          backend: runtime.backend,
          provider: runtime.extractProvider,
          registry: runtime.registry,
          fetcher: runtime.fetcher,
          now: runtime.now,
          maxDocs: runtime.maxDocs,
          parsePdf: runtime.parsePdf,
        },
        { label: options.name },
      );
      write(formatIngest(result));
      return { runtime, docId: result.doc.docId };
    } catch (error) {
      if (error instanceof AppError && error.code === 'WRAPPER_PAGE') {
        const links = Array.isArray(error.details?.links)
          ? (error.details.links as { url: string; text: string }[])
          : [];
        const list = links.map(
          (l) => `  ${l.url}${l.text ? `  (${l.text})` : ''}`,
        );
        const message = [
          error.userMessage,
          ...list,
          'Run again with one of these links.',
        ].join('\n');
        throw new AppError('WRAPPER_PAGE', error.message, {
          userMessage: message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      throw error;
    }
  }

  const program = new Command()
    .name(BRAND.name)
    .description('Ask plain-language questions about one legislation document.')
    .version(packageJson.version)
    .argument('<url>', 'ingest a URL, then serve and open its document')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (url: string, options: BackendOption) => {
      const { runtime, docId } = await ingestUrl(url, options);
      if (dependencies.serve) await dependencies.serve(runtime, docId);
      else
        write(
          `\nThe web UI is not available yet. Ask questions with: ${BRAND.name} ask ${docId.slice(0, 12)} "<question>"\n`,
        );
    });

  program
    .command('init')
    .description('configure provider keys locally')
    .option(
      '--force',
      'replace an existing config file whose permissions are too open',
    )
    .action(async (options: { force?: boolean }) => {
      const force = options.force ?? false;
      await (dependencies.init?.({ force }) ??
        initConfig({ prompt: promptSecret, choose: promptChoice, force }));
      console.log('Configuration saved with private file permissions.');
    });
  program
    .command('ingest <url>')
    .description('ingest a legislation document')
    .option('--name <label>', 'label for the document')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (url: string, options: BackendOption & { name?: string }) => {
      await ingestUrl(url, options);
    });
  program
    .command('ask <doc> [question]')
    .description('ask about a document by label or doc-id prefix')
    .option('--chip <id>', 'ask a predefined question chip')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(
      async (
        doc: string,
        question: string | undefined,
        options: BackendOption & { chip?: string },
      ) => {
        if ((question === undefined) === (options.chip === undefined))
          throw new AppError('INVALID_INPUT', 'Need a question or --chip.', {
            userMessage: 'Provide either a question or --chip <id>, not both.',
          });
        const chip =
          options.chip === undefined
            ? undefined
            : ChipId.safeParse(options.chip);
        if (chip && !chip.success)
          throw new AppError('INVALID_INPUT', 'Unknown chip.', {
            userMessage: `Unknown chip "${String(options.chip)}". Choose one of: ${ChipId.options.join(', ')}.`,
          });
        const runtime = await open(options, true);
        const entry = await runtime.registry.findByLabelOrPrefix(doc);
        const result = await ask(
          entry.docId,
          chip?.success ? { chipId: chip.data } : { question: question ?? '' },
          {
            backend: runtime.backend,
            provider: runtime.answerProvider,
            registry: runtime.registry,
            retrievalMode: runtime.retrievalMode,
            chips: runtime.chips,
          },
          { onToken: write },
        );
        const normalized = await runtime.registry.getDocument(entry.docId);
        write(`\n${formatAskFooter(result, normalized)}`);
      },
    );
  program
    .command('list')
    .description('list ingested documents')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (options: BackendOption) => {
      const runtime = await open(options, false);
      write(formatList(await runtime.registry.list()));
    });
  program
    .command('remove <doc>')
    .description('remove a document')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (doc: string, options: BackendOption) => {
      const runtime = await open(options, false);
      const entry = await runtime.registry.findByLabelOrPrefix(doc);
      if (entry.backend === runtime.backend.kind)
        await runtime.backend.deleteDocument(entry.docId);
      await runtime.registry.remove(entry.docId);
      write(`Removed ${entry.label}\n`);
    });
  program
    .command('serve')
    .description('serve the local web UI')
    .option('--port <port>', 'local server port', '4317')
    .option('--public', 'allow only question chips in the web UI')
    .action(notImplemented(29));
  program
    .command('eval')
    .description('evaluate retrieval on fixtures')
    .option('--fixture <name>', 'fixture to evaluate')
    .option('--mode <mode>', 'dense, sparse, hybrid, hybrid_rerank, or all')
    .action(notImplemented(32));

  return program;
}
