import type { Section } from '../../src/core/model/index.js';

/** Expected parser facts, independent of how a parser discovers them. */
export interface SampleGroundTruth {
  sections: Section[];
  deletedStrings: string[];
  insertedStrings: string[];
}

export interface SyntheticSample<
  T extends SampleGroundTruth = SampleGroundTruth,
> {
  bytes: Uint8Array;
  groundTruth: T;
}
