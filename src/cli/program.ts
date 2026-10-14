// CLI command definitions. Each command is a thin wrapper over the shared pipeline.
import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND } from '../core/brand.js';
import { initConfig } from '../core/config.js';
import { AppError, ChipId, type LlmProvider } from '../core/model/index.js';
import { ask, ingest } from '../core/pipeline/index.js';
import { runEvalCommand } from '../eval/command.js';
import { safeText } from './sanitize.js';
import { formatAskFooter, formatIngest, formatList } from './format.js';
import {
  createRuntime,
  type CliRuntime,
  type RuntimeFactory,
} from './runtime.js';
import { promptChoice, promptSecret } from './secret-prompt.js';
import { createLauncher, type Launcher } from '../server/launch.js';
import { prepareIngestSource } from './ingest-source.js';

export interface CliDependencies {
  init?: (options: { force: boolean }) => Promise<unknown>;
  runtime?: RuntimeFactory;
  /** Where command output goes. Default: process.stdout. */
  write?: (text: string) => void;
  /** Starts the web server (and opens the browser unless public). Default: the real one. */
  serve?: Launcher;
}

interface PortOptions {
  port?: string;
  host?: string;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new AppError('INVALID_INPUT', 'Bad port.', {
      userMessage: 'The port must be a whole number from 0 to 65535.',
    });
  return port;
}

interface BackendOption {
  backend?: string;
}

/**
 * Defers reading the provider (which throws MISSING_KEY when no key is configured) until it is
 * used, so chips that make no LLM call, like sponsors, work without a key.
 */
function lazyProvider(get: () => LlmProvider): LlmProvider {
  return {
    get id() {
      return get().id;
    },
    get model() {
      return get().model;
    },
    streamText: (req) => get().streamText(req),
    generateObject: (req) => get().generateObject(req),
  };
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

  async function ingestSource(
    url: string,
    options: BackendOption & { name?: string },
  ): Promise<{ runtime: CliRuntime; docId: string }> {
    const runtime = await open(options, true);
    try {
      const source = await prepareIngestSource(
        url,
        runtime.fetcher,
        await runtime.registry.list(),
      );
      const result = await ingest(
        url,
        {
          backend: runtime.backend,
          provider: runtime.extractProvider,
          registry: runtime.registry,
          fetcher: source.fetcher,
          now: runtime.now,
          maxDocs: runtime.maxDocs,
          parsePdf: runtime.parsePdf,
        },
        { label: options.name ?? source.label },
      );
      write(formatIngest(result));
      return { runtime, docId: result.doc.docId };
    } catch (error) {
      if (error instanceof AppError && error.code === 'WRAPPER_PAGE') {
        const links = Array.isArray(error.details?.links)
          ? (error.details.links as { url: string; text: string }[])
          : [];
        const list = links.map((l) =>
          safeText(`  ${l.url}${l.text ? `  (${l.text})` : ''}`),
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
    // Without this the root's --backend swallows the flag before subcommands see it.
    .enablePositionalOptions()
    .name(BRAND.name)
    .description('Ask plain-language questions about one legislation document.')
    .version(packageJson.version)
    .argument(
      '<url-or-path>',
      'ingest a URL or local file, then open its document',
    )
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (url: string, options: BackendOption) => {
      const { runtime } = await ingestSource(url, options);
      // The UI lists the most recently used document first, which is the one just ingested.
      await (dependencies.serve ?? createLauncher({ write }))(runtime, {
        publicMode: false,
      });
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
    .command('ingest <url-or-path>')
    .description('ingest a legislation document')
    .option('--name <label>', 'label for the document')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (url: string, options: BackendOption & { name?: string }) => {
      await ingestSource(url, options);
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
        // Keys are only required once an LLM call happens; freeform questions always need one,
        // so fail before retrieval spends anything.
        const runtime = await open(options, false);
        const provider =
          question === undefined
            ? lazyProvider(() => runtime.answerProvider)
            : runtime.answerProvider;
        const entry = await runtime.registry.findByLabelOrPrefix(doc);
        const result = await ask(
          entry.docId,
          chip?.success ? { chipId: chip.data } : { question: question ?? '' },
          {
            backend: runtime.backend,
            provider,
            registry: runtime.registry,
            retrievalMode: runtime.retrievalMode,
            chips: runtime.chips,
          },
          {
            onToken: (text) => {
              write(safeText(text));
            },
          },
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
      // A namespace can only be deleted through the backend that holds it. Dropping the entry
      // anyway would orphan it (and, on Pinecone, keep it billed), so refuse instead.
      if (entry.backend !== runtime.backend.kind)
        throw new AppError('INVALID_INPUT', 'Document is on another backend.', {
          userMessage: `${safeText(entry.label)} was indexed with the ${entry.backend} backend. Run again with --backend ${entry.backend}.`,
        });
      await runtime.backend.deleteDocument(entry.docId);
      await runtime.registry.remove(entry.docId);
      write(`Removed ${safeText(entry.label)}\n`);
    });
  program
    .command('serve')
    .description('serve the local web UI')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .option('--port <port>', 'local server port (default 4317)')
    .option('--host <host>', 'address to bind (default 127.0.0.1)')
    .option('--public', 'allow only question chips in the web UI')
    .action(
      async (options: BackendOption & PortOptions & { public?: boolean }) => {
        const runtime = await open(options, true);
        await (dependencies.serve ?? createLauncher({ write }))(runtime, {
          publicMode: options.public ?? false,
          port: parsePort(options.port),
          host: options.host,
        });
      },
    );
  program
    .command('eval')
    .description('evaluate retrieval on fixtures')
    .option('--fixture <name>', 'fixture to evaluate')
    .option(
      '--mode <mode>',
      'dense, sparse, hybrid, hybrid_rerank, or all (default all)',
    )
    .option('--backend <backend>', 'local or pinecone (default: both)')
    .option('--answers', 'also generate and score answers (needs a provider)')
    .option('--golden <dir>', 'golden set directory', 'src/eval/golden')
    .option('--fixtures <dir>', 'fixtures directory', 'fixtures')
    .option('--out <file>', 'results file', 'eval/results.md')
    .action(
      async (options: {
        fixture?: string;
        mode?: string;
        backend?: string;
        answers?: boolean;
        golden?: string;
        fixtures?: string;
        out?: string;
      }) => {
        await runEvalCommand(options, {
          runtime: dependencies.runtime ?? createRuntime,
          write,
        });
      },
    );

  return program;
}
