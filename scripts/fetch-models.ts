import { parseArgs } from 'node:util';
import { envVar } from '../src/core/brand.js';
import { createLocalModels } from '../src/core/index/local/models.js';

const { values } = parseArgs({ options: { 'config-dir': { type: 'string' } } });
const configDir = values['config-dir'] ?? process.env[envVar('CONFIG_DIR')];
const models = createLocalModels(configDir ? { configDir } : {});
try {
  await models.embedder.ensureReady();
  await models.reranker.ensureReady();
  console.log('Local models are cached and ready for offline use.');
} finally {
  await models.dispose();
}
