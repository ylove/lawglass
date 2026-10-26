// CLI command definitions. Each command is a thin wrapper over the shared pipeline.
import { deleteIndexedDocument } from '../core/answer/context.js';
import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND } from '../core/brand.js';
import { CHIPS } from '../core/chips.js';
import { lazyProvider } from '../core/llm/lazy-provider.js';
import { initConfig } from '../core/config.js';
import { AppError, ChipId, ERROR_CODES } from '../core/model/index.js';
import { ask, ingest } from '../core/pipeline/index.js';
import { runEvalCommand } from '../eval/command.js';
import { runCompareCommand, type CompareOptions } from '../eval/compare.js';
import { unescapeDelegationList } from '../core/chip-delegations.js';
import { unescapeRecordText } from '../core/chip-history.js';
import { safeText } from './sanitize.js';
import {
  finalTextDiffers,
  formatAnswerLog,
  formatAskFooter,
  formatIngest,
  formatList,
} from './format.js';
import {
  createRuntime,
  type CliRuntime,
  type RuntimeFactory,
} from './runtime.js';
import { promptChoice, promptSecret } from './secret-prompt.js';
import { createLauncher, type Launcher } from '../server/launch.js';
import { prepareIngestSource } from './ingest-source.js';
import { readAccessKey } from '../server/session.js';
import { validateBindHost } from '../server/bind.js';
import { launchMcp, type McpLauncher } from '../mcp/launch.js';
import { getSection, searchDocument } from '../mcp/queries.js';
import { toErrorPayload, ToolError } from '../mcp/errors.js';
import { UntrustedText } from '../mcp/untrusted.js';

export interface CliDependencies {
  init?: (options: {
    force: boolean;
    nonInteractive?: boolean;
    backend?: string;
  }) => Promise<unknown>;
  runtime?: RuntimeFactory;
  /** Where command output goes. Default: process.stdout. */
  write?: (text: string) => void;
  /** Starts the web server (and opens the browser unless public). Default: the real one. */
  serve?: Launcher;
  /** Serves the MCP protocol on stdio. Default: the real server. */
  mcp?: McpLauncher;
}

/** Commander turns `--no-open` into `open: false`; it is `true` when the flag is absent. */
interface OpenOptions {
  open?: boolean;
}

function noOpenRequest(options: OpenOptions): { noOpen?: true } {
  return options.open === false ? { noOpen: true } : {};
}

interface PortOptions {
  port?: string;
  host?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const megabytes = bytes / (1024 * 1024);
  return megabytes < 0.1
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${megabytes.toFixed(1)} MB`;
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

function formatJson(value: unknown, compact: boolean | undefined): string {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
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
    hostedMode?: boolean,
  ): Promise<CliRuntime> =>
    (dependencies.runtime ?? createRuntime)({
      backend: options.backend,
      needsLlm,
      ...(hostedMode ? { hostedMode: true } : {}),
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

  /**
   * Prints a query result. A tool-level failure (bad section, document not ingested) keeps its
   * fixed message: `--json` gets the same `{error:{code,message}}` the MCP tools return.
   */
  async function printQuery(
    json: boolean | undefined,
    task: () => Promise<unknown>,
  ): Promise<void> {
    try {
      write(formatJson(await task(), json));
    } catch (error) {
      if (!(error instanceof ToolError || error instanceof AppError))
        throw error;
      // The MCP wording for an unknown document tells an agent to call the ingest tool; a person
      // at the CLI gets the plain message.
      const payload =
        error instanceof AppError && error.code === 'DOC_NOT_FOUND'
          ? {
              error: {
                code: error.code,
                message: ERROR_CODES.DOC_NOT_FOUND,
              },
            }
          : toErrorPayload(error);
      if (json) write(formatJson(payload, true));
      else console.error(payload.error.message);
      process.exitCode = 1;
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
    .option('--no-open', 'do not open the browser')
    .option('--host <host>', 'IP literal or localhost (default 127.0.0.1)')
    .option('--port <port>', 'local server port (default 4317)')
    .option('--public', 'explicitly allow a network bind; question chips only')
    .action(
      async (
        url: string,
        options: BackendOption &
          OpenOptions &
          PortOptions & { public?: boolean },
      ) => {
        validateBindHost(options.host, options.public);
        const port = parsePort(options.port);
        const { runtime, docId } = await ingestSource(url, options);
        // The browser opens straight to the document just ingested.
        await (dependencies.serve ?? createLauncher({ write }))(runtime, {
          publicMode: options.public ?? false,
          docId,
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(port === undefined ? {} : { port }),
          ...noOpenRequest(options),
        });
      },
    );

  program
    .command('init')
    .description('configure provider keys locally')
    .option(
      '--force',
      'replace an existing config file whose permissions are too open',
    )
    .option('--non-interactive', 'save environment settings without prompting')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(
      async (options: {
        force?: boolean;
        nonInteractive?: boolean;
        backend?: string;
      }) => {
        const initOptions = {
          force: options.force ?? false,
          ...(options.nonInteractive ? { nonInteractive: true } : {}),
          ...(options.backend === undefined
            ? {}
            : { backend: options.backend }),
        };
        await (dependencies.init?.(initOptions) ??
          initConfig({
            prompt: promptSecret,
            choose: promptChoice,
            ...initOptions,
          }));
        console.log('Configuration saved with private file permissions.');
      },
    );
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
    .option('--json', 'output the answer as JSON')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(
      async (
        doc: string,
        question: string | undefined,
        options: BackendOption & { chip?: string; json?: boolean },
      ) => {
        if ((question === undefined) === (options.chip === undefined))
          throw new AppError('INVALID_INPUT', 'Need a question or --chip.', {
            userMessage: 'Provide either a question or --chip <id>, not both.',
          });
        const chip =
          options.chip === undefined
            ? undefined
            : ChipId.safeParse(options.chip);
        const served = CHIPS.map((c) => c.id as string);
        if (chip && (!chip.success || !served.includes(chip.data)))
          throw new AppError('INVALID_INPUT', 'Unknown chip.', {
            userMessage: `Unknown chip "${String(options.chip)}". Choose one of: ${served.join(', ')}.`,
          });
        // Keys are only required once an LLM call happens; freeform questions always need one,
        // so fail before retrieval spends anything.
        const runtime = await open(options, false);
        const provider =
          question === undefined
            ? lazyProvider(() => runtime.answerProvider)
            : runtime.answerProvider;
        const entry = await runtime.registry.findByLabelOrPrefix(doc);
        // History and delegations escape quoted record text for the web renderer. For
        // delegations only the list is ours; the model's lede prints unchanged.
        const unescape =
          chip?.success !== true
            ? undefined
            : chip.data === 'history'
              ? unescapeRecordText
              : chip.data === 'delegations'
                ? unescapeDelegationList
                : undefined;
        let streamed = '';
        const result = await ask(
          entry.docId,
          chip?.success ? { chipId: chip.data } : { question: question ?? '' },
          {
            backend: runtime.backend,
            provider,
            registry: runtime.registry,
            retrievalMode: runtime.retrievalMode,
            chips: runtime.chips,
            readingLevel: {},
            log: (e) => {
              if (!options.json)
                process.stderr.write(`${formatAnswerLog(e)}\n`);
            },
          },
          {
            onToken: (text) => {
              if (options.json) return;
              streamed += text;
              write(safeText(unescape ? unescape(text) : text));
            },
          },
        );
        if (options.json) {
          write(`${JSON.stringify(result.answer, null, 2)}\n`);
          return;
        }
        // The answer streamed above as the model wrote it. When the final text differs (a
        // reading-level rewrite, or sentences about "the excerpts" removed), print it once
        // more rather than buffer every answer, which would delay the first word of all of them.
        // The history chip's own text is never changed after streaming.
        if (!unescape && finalTextDiffers(streamed, result.answer.text))
          write(
            `\n\n${result.answer.simplified ? 'In simpler words' : 'Final answer'}:\n${safeText(result.answer.text)}\n`,
          );
        const normalized = await runtime.registry.getDocument(entry.docId);
        write(`\n${formatAskFooter(result, normalized)}`);
      },
    );
  program
    .command('search <doc> <query>')
    .description(
      'search a document; prints the same JSON as the MCP search tool',
    )
    .option('--cursor <cursor>', 'cursor from a previous result, for more hits')
    .option('--json', 'print compact JSON on one line')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(
      async (
        doc: string,
        query: string,
        options: BackendOption & { cursor?: string; json?: boolean },
      ) => {
        const runtime = await open(options, false);
        await printQuery(options.json, async () => {
          const entry = await runtime.registry.findByLabelOrPrefix(doc);
          return searchDocument(
            runtime,
            entry.docId,
            { query, cursor: options.cursor },
            new UntrustedText(),
          );
        });
      },
    );
  program
    .command('get-section <doc> <section>')
    .description('print one section; the same JSON as the MCP get_section tool')
    .option('--view <view>', 'current (default) or redline', 'current')
    .option(
      '--cursor <cursor>',
      'cursor from a previous result, for a long section',
    )
    .option('--json', 'print compact JSON on one line')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(
      async (
        doc: string,
        section: string,
        options: BackendOption & {
          view: string;
          cursor?: string;
          json?: boolean;
        },
      ) => {
        const runtime = await open(options, false);
        await printQuery(options.json, async () => {
          const entry = await runtime.registry.findByLabelOrPrefix(doc);
          return getSection(
            runtime,
            entry.docId,
            { section, view: options.view, cursor: options.cursor },
            new UntrustedText(),
          );
        });
      },
    );
  program
    .command('mcp')
    .description(
      'serve the Model Context Protocol on stdio, for AI agents (reads stdin, writes only protocol messages to stdout)',
    )
    .action(async () => {
      // Local backend only: no key, and an agent never reaches a hosted index.
      await (dependencies.mcp ?? launchMcp)(() =>
        open({ backend: 'local' }, false),
      );
    });
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
      await deleteIndexedDocument(runtime.backend, entry.docId);
      await runtime.registry.remove(entry.docId);
      write(`Removed ${safeText(entry.label)}\n`);
    });
  const cache = program
    .command('cache')
    .description('manage the local download cache');
  cache
    .command('clear')
    .description(
      'delete cached downloads (documents, indexes and answers are kept)',
    )
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(async (options: BackendOption) => {
      const runtime = await open(options, false);
      const { snapshots, bytes } = await runtime.clearFetchCache();
      write(
        `Cleared ${String(snapshots)} cached ${snapshots === 1 ? 'download' : 'downloads'} (${formatBytes(bytes)}).\n`,
      );
    });
  program
    .command('serve')
    .description('serve the local web UI')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .option('--port <port>', 'local server port (default 4317)')
    .option('--host <host>', 'address to bind (default 127.0.0.1)')
    .option('--public', 'allow only question chips in the web UI')
    .option('--private', 'invite-only preview with the full app')
    .option(
      '--trust-proxy <hops>',
      'trusted proxy hops, counted from the right',
      '0',
    )
    .option('--no-open', 'do not open the browser')
    .action(
      async (
        options: BackendOption &
          PortOptions &
          OpenOptions & {
            public?: boolean;
            private?: boolean;
            trustProxy?: string;
          },
      ) => {
        if (options.private && options.public) {
          const message = '--private and --public cannot be used together.';
          throw new AppError('INVALID_INPUT', message, {
            userMessage: message,
          });
        }
        const trustProxyHops = Number(options.trustProxy);
        if (
          !/^\d+$/.test(options.trustProxy ?? '') ||
          !Number.isSafeInteger(trustProxyHops)
        ) {
          const message =
            '--trust-proxy must be a whole number of hops, 0 or greater.';
          throw new AppError('INVALID_INPUT', message, {
            userMessage: message,
          });
        }
        if (options.private) readAccessKey();
        validateBindHost(options.host, options.public, options.private);
        const port = parsePort(options.port);
        const runtime = await open(
          options,
          true,
          (options.public ?? false) || (options.private ?? false),
        );
        await (dependencies.serve ?? createLauncher({ write }))(runtime, {
          publicMode: options.public ?? false,
          ...(options.private ? { privateMode: true } : {}),
          ...(trustProxyHops > 0 ? { trustProxyHops } : {}),
          port,
          host: options.host,
          ...noOpenRequest(options),
        });
      },
    );
  const evalCommand = program
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

  evalCommand
    .command('compare <run.json>')
    .description('list questions where top-5 relevance differs between modes')
    .requiredOption('--a <mode>', 'first mode (e.g. dense or hybrid/weighted)')
    .requiredOption('--b <mode>', 'second mode (e.g. hybrid_rerank)')
    .option('--fixture <name>', 'compare only this fixture')
    .action(async (file: string, options: CompareOptions) => {
      await runCompareCommand(file, options, write);
    });

  return program;
}
