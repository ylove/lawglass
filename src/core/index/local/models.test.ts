import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BGE_QUERY_PREFIX,
  MODEL_LOCK,
  createLocalModels,
  defaultConfigDir,
} from './models.js';
import { BRAND } from '../../brand.js';
import { AppError } from '../../model/index.js';
import { ensureVerifiedModelFiles } from './model-files.js';

const mocks = vi.hoisted(() => {
  const env = {
    cacheDir: '',
    allowRemoteModels: true,
    allowLocalModels: true,
    useFSCache: false,
  };
  const dispose = vi.fn();
  const tensorDispose = vi.fn();
  const tokenizer = vi.fn((texts: string | string[], _options: unknown) => ({
    attention_mask: {
      data: Array.from(
        { length: (typeof texts === 'string' ? 1 : texts.length) * 3 },
        (_v, i) => (i % 3 === 2 ? 0n : 1n),
      ),
    },
  }));
  const extract = vi.fn((texts: string[]) =>
    Promise.resolve({
      data: new Float32Array(texts.length * 384).fill(0.5),
      size: texts.length * 384,
      dispose: tensorDispose,
    }),
  );
  const pipe = Object.assign(extract, { tokenizer, dispose });
  const pipeline = vi.fn(function (_options: unknown) {
    return pipe;
  });
  const model = Object.assign(
    vi.fn((_inputs: unknown) =>
      Promise.resolve({
        logits: { data: new Float32Array([42]), dispose: tensorDispose },
      }),
    ),
    { dispose },
  );
  return {
    env,
    dispose,
    tensorDispose,
    tokenizer,
    extract,
    pipeline,
    model,
    loadTokenizer: vi.fn(() => Promise.resolve(tokenizer)),
    loadModel: vi.fn(() => Promise.resolve(model)),
    loadEmbeddingModel: vi.fn(() => Promise.resolve(model)),
  };
});
vi.mock('@huggingface/transformers', () => ({
  env: mocks.env,
  FeatureExtractionPipeline: mocks.pipeline,
  AutoModel: { from_pretrained: mocks.loadEmbeddingModel },
  AutoTokenizer: { from_pretrained: mocks.loadTokenizer },
  AutoModelForSequenceClassification: { from_pretrained: mocks.loadModel },
}));

// Hash verification has its own offline suite (model-files.test.ts); here it is a spy.
vi.mock('./model-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model-files.js')>()),
  ensureVerifiedModelFiles: vi.fn(() => Promise.resolve()),
}));

describe('lazy Transformers adapters', () => {
  let configDir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    configDir = await mkdtemp(join(tmpdir(), 'local-model-unit-'));
  });
  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('uses the brand config directory', () => {
    expect(defaultConfigDir()).toBe(
      join(process.env.HOME ?? '', BRAND.configDirName),
    );
  });

  it('does not load at construction, pins revisions and q8, announces only once', async () => {
    const logger = vi.fn();
    const models = createLocalModels({ configDir, logger });
    expect(mocks.pipeline).not.toHaveBeenCalled();
    await Promise.all([
      models.embedder.ensureReady(),
      models.embedder.ensureReady(),
    ]);
    await models.reranker.ensureReady();
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.loadEmbeddingModel).toHaveBeenCalledWith(
      MODEL_LOCK.embedding.id,
      expect.objectContaining({
        revision: MODEL_LOCK.embedding.revision,
        dtype: 'q8',
        device: 'cpu',
        cache_dir: join(configDir, 'models'),
        local_files_only: false,
      }),
    );
    expect(mocks.loadModel).toHaveBeenCalledWith(
      MODEL_LOCK.reranker.id,
      expect.objectContaining({
        revision: MODEL_LOCK.reranker.revision,
        dtype: 'q8',
      }),
    );
    expect(logger).toHaveBeenCalledExactlyOnceWith(
      'Downloading local models (~59 MB, first run only)…',
    );
    expect(mocks.env).toMatchObject({
      cacheDir: join(configDir, 'models'),
      allowRemoteModels: true,
      allowLocalModels: false,
      useFSCache: true,
    });
    await models.dispose();
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  });

  it('counts tokenizer attention tokens, excludes padding, prefixes only queries and uses CLS', async () => {
    const models = createLocalModels({ configDir, logger: vi.fn() });
    const docs = await models.embedder.embed(
      ['document', 'second document'],
      'document',
    );
    expect(docs.tokens).toBe(4);
    expect(docs.vectors).toHaveLength(2);
    expect(docs.vectors[0]).toHaveLength(384);
    expect(mocks.extract).toHaveBeenCalledWith(
      ['document', 'second document'],
      { pooling: 'cls', normalize: true },
    );
    const query = await models.embedder.embed(['query'], 'query');
    expect(query.tokens).toBe(2);
    expect(mocks.extract).toHaveBeenLastCalledWith(
      [BGE_QUERY_PREFIX + 'query'],
      { pooling: 'cls', normalize: true },
    );
    expect(mocks.tensorDispose).toHaveBeenCalledTimes(2);
    const many = await models.embedder.embed(
      Array<string>(17).fill('text'),
      'document',
    );
    expect(many.vectors).toHaveLength(17);
    expect(many.tokens).toBe(34);
    expect(mocks.extract).toHaveBeenCalledTimes(5);
    await models.dispose();
  });

  it('scores query/document pairs using the raw single-label logits', async () => {
    const models = createLocalModels({ configDir, logger: vi.fn() });
    expect(await models.reranker.score('query', ['first', 'second'])).toEqual([
      42, 42,
    ]);
    expect(mocks.tokenizer).toHaveBeenCalledWith('query', {
      text_pair: 'first',
      padding: true,
      truncation: true,
    });
    expect(mocks.tokenizer).toHaveBeenCalledWith('query', {
      text_pair: 'second',
      padding: true,
      truncation: true,
    });
    expect(mocks.tensorDispose).toHaveBeenCalledTimes(2);
    await models.dispose();
  });

  it('avoids announcing downloads with a complete revision-specific cache', async () => {
    for (const model of [MODEL_LOCK.embedding, MODEL_LOCK.reranker]) {
      const dir = join(configDir, 'models', model.id, model.revision);
      await mkdir(join(dir, 'onnx'), { recursive: true });
      for (const file of [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'onnx/model_quantized.onnx',
      ])
        await writeFile(join(dir, file), 'cached');
    }
    const logger = vi.fn();
    const models = createLocalModels({ configDir, logger });
    await models.embedder.ensureReady();
    await models.reranker.ensureReady();
    expect(logger).not.toHaveBeenCalled();
    await models.dispose();
  });

  it('disables remote downloads for offline runs and avoids loading for empty input', async () => {
    const logger = vi.fn();
    const models = createLocalModels({
      configDir,
      allowRemoteModels: false,
      logger,
    });
    expect(await models.embedder.embed([], 'document')).toEqual({
      vectors: [],
      tokens: 0,
    });
    expect(await models.reranker.score('query', [])).toEqual([]);
    await models.dispose();
    expect(mocks.pipeline).not.toHaveBeenCalled();
    await models.embedder.ensureReady();
    expect(mocks.env.allowRemoteModels).toBe(false);
    expect(mocks.loadEmbeddingModel).toHaveBeenCalledWith(
      join(
        configDir,
        'models',
        MODEL_LOCK.embedding.id,
        MODEL_LOCK.embedding.revision,
      ),
      expect.objectContaining({ local_files_only: true }),
    );
    expect(logger).not.toHaveBeenCalled();
    await models.dispose();
  });

  it('wraps failed loads and allows retry', async () => {
    const models = createLocalModels({ configDir, logger: vi.fn() });
    mocks.loadEmbeddingModel.mockRejectedValueOnce(
      new Error('download failed'),
    );
    await expect(models.embedder.ensureReady()).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    await models.embedder.ensureReady();
    mocks.loadModel.mockRejectedValueOnce(new Error('download failed'));
    await expect(models.reranker.ensureReady()).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    await models.reranker.ensureReady();
    await models.dispose();
  });

  it('rejects aborted work without loading and checks cancellation after loads', async () => {
    const controller = new AbortController();
    controller.abort();
    const models = createLocalModels({ configDir, logger: vi.fn() });
    await expect(
      models.embedder.ensureReady(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      models.reranker.ensureReady(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      models.embedder.embed(['x'], 'query', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      models.reranker.score('x', ['y'], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.pipeline).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.loadEmbeddingModel.mockImplementationOnce(() => {
      during.abort();
      return Promise.resolve(mocks.model);
    });
    await expect(
      models.embedder.ensureReady(during.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await models.dispose();
  });

  it('rejects unexpected classifier output and disposes its tensor', async () => {
    const models = createLocalModels({ configDir, logger: vi.fn() });
    mocks.model.mockResolvedValueOnce({
      logits: { data: new Float32Array([1, 2]), dispose: mocks.tensorDispose },
    });
    await expect(models.reranker.score('q', ['x'])).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    expect(mocks.tensorDispose).toHaveBeenCalledOnce();
    await models.dispose();
  });

  it('keeps global model settings stable across concurrent cache contexts', async () => {
    let markStarted: () => void = () => undefined;
    let releaseLoad: () => void = () => undefined;
    const started = new Promise<undefined>((resolve) => {
      markStarted = () => {
        resolve(undefined);
      };
    });
    const release = new Promise<undefined>((resolve) => {
      releaseLoad = () => {
        resolve(undefined);
      };
    });
    const online = createLocalModels({ configDir, logger: vi.fn() });
    const offlineDir = join(configDir, 'offline');
    const offline = createLocalModels({
      configDir: offlineDir,
      allowRemoteModels: false,
    });
    mocks.loadEmbeddingModel.mockImplementationOnce(async () => {
      markStarted();
      await release;
      expect(mocks.env.cacheDir).toBe(join(configDir, 'models'));
      expect(mocks.env.allowRemoteModels).toBe(true);
      return mocks.model;
    });
    const first = online.embedder.ensureReady();
    await started;
    const second = offline.embedder.ensureReady();
    releaseLoad();
    await Promise.all([first, second]);
    expect(mocks.env.cacheDir).toBe(join(offlineDir, 'models'));
    expect(mocks.env.allowRemoteModels).toBe(false);
    await online.dispose();
    await offline.dispose();
  });

  it('verifies the locked file hashes before transformers loads anything', async () => {
    const models = createLocalModels({ configDir, logger: vi.fn() });
    await models.reranker.ensureReady();
    expect(ensureVerifiedModelFiles).toHaveBeenCalledExactlyOnceWith(
      MODEL_LOCK.reranker,
      expect.objectContaining({
        cacheDir: join(configDir, 'models'),
        allowRemote: true,
      }),
    );
    await models.dispose();
  });

  it('surfaces a hash mismatch as-is and never loads the model', async () => {
    const mismatch = new AppError(
      'BACKEND_UNAVAILABLE',
      'failed its SHA-256 check',
    );
    vi.mocked(ensureVerifiedModelFiles).mockRejectedValueOnce(mismatch);
    const models = createLocalModels({ configDir, logger: vi.fn() });
    await expect(models.embedder.ensureReady()).rejects.toBe(mismatch);
    expect(mocks.loadTokenizer).not.toHaveBeenCalled();
    expect(mocks.loadEmbeddingModel).not.toHaveBeenCalled();
    await models.dispose();
  });
});
