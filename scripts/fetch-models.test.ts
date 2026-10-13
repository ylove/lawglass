import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envVar } from '../src/core/brand.js';

const mocks = vi.hoisted(() => {
  const embedReady = vi.fn(() => Promise.resolve());
  const rerankReady = vi.fn(() => Promise.resolve());
  const dispose = vi.fn(() => Promise.resolve());
  return {
    embedReady,
    rerankReady,
    dispose,
    parseArgs: vi.fn((): { values: Record<string, string | undefined> } => ({
      values: {},
    })),
    createModels: vi.fn(() => ({
      embedder: { ensureReady: embedReady },
      reranker: { ensureReady: rerankReady },
      dispose,
    })),
  };
});
vi.mock('node:util', () => ({ parseArgs: mocks.parseArgs }));
vi.mock('../src/core/index/local/models.js', () => ({
  createLocalModels: mocks.createModels,
}));

describe('fetch-models command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.parseArgs.mockReturnValue({ values: {} });
    vi.stubEnv(envVar('CONFIG_DIR'), undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('preloads both locked models and releases sessions', async () => {
    await import('./fetch-models.js');
    expect(mocks.createModels).toHaveBeenCalledWith({});
    expect(mocks.embedReady).toHaveBeenCalledOnce();
    expect(mocks.rerankReady).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(
      'Local models are cached and ready for offline use.',
    );
  });

  it('prefers the explicit config directory over the brand environment variable', async () => {
    vi.stubEnv(envVar('CONFIG_DIR'), '/tmp/from-env');
    mocks.parseArgs.mockReturnValue({
      values: { 'config-dir': '/tmp/explicit' },
    });
    await import('./fetch-models.js');
    expect(mocks.createModels).toHaveBeenCalledWith({
      configDir: '/tmp/explicit',
    });
  });

  it('uses the brand environment variable when no argument is provided', async () => {
    vi.stubEnv(envVar('CONFIG_DIR'), '/tmp/from-env');
    await import('./fetch-models.js');
    expect(mocks.createModels).toHaveBeenCalledWith({
      configDir: '/tmp/from-env',
    });
  });

  it('releases loaded sessions when the second model fails', async () => {
    mocks.rerankReady.mockRejectedValueOnce(new Error('download failed'));
    await expect(import('./fetch-models.js')).rejects.toThrow(
      'download failed',
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });
});
