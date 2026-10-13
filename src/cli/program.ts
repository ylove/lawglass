// CLI command definitions; later issues supply their implementations.
import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND } from '../core/brand.js';
import { initConfig } from '../core/config.js';
import { promptSecret } from './secret-prompt.js';

function notImplemented(issue: number): () => void {
  return () => {
    console.log(`not implemented yet (see issue #${String(issue)})`);
    process.exitCode = 2;
  };
}

export function createProgram(dependencies: { init?: () => Promise<unknown> } = {}): Command {
  const program = new Command()
    .name(BRAND.name)
    .description('Ask plain-language questions about one legislation document.')
    .version(packageJson.version)
    .argument('<url>', 'ingest a URL, then serve and open its document')
    .option('--backend <backend>', 'retrieval backend (pinecone or local)')
    .action(notImplemented(28));

  program
    .command('init')
    .description('configure provider keys locally')
    .action(async () => {
      await (dependencies.init?.() ?? initConfig({ prompt: promptSecret }));
      console.log('Configuration saved with private file permissions.');
    });
  program
    .command('ingest <url>')
    .description('ingest a legislation document')
    .option('--name <label>', 'label for the document')
    .action(notImplemented(28));
  program
    .command('ask <doc> [question]')
    .description('ask about a document by label or doc-id prefix')
    .option('--chip <id>', 'ask a predefined question chip')
    .action(notImplemented(28));
  program
    .command('list')
    .description('list ingested documents')
    .action(notImplemented(28));
  program
    .command('remove <doc>')
    .description('remove a document')
    .action(notImplemented(28));
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
