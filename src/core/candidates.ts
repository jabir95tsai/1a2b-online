import { parseFeedback } from './rules.ts';
import type { Feedback } from './rules.ts';
import { CANDIDATE_COUNT, codeId, scoreIdsUnchecked } from './internal/universe.ts';

export { ALL_CODES, CANDIDATE_COUNT, codeAt, codeId } from './internal/universe.ts';
export const CANDIDATE_BYTES = CANDIDATE_COUNT / 8;

/** Immutable 5040-bit value; toBytes/fromBytes always copy to prevent aliasing. */
export class CandidateSet {
  readonly #bits: Uint8Array;
  readonly size: number;

  private constructor(bits: Uint8Array) {
    this.#bits = bits;
    let size = 0;
    for (let byte of bits) {
      while (byte !== 0) {
        byte &= byte - 1;
        size++;
      }
    }
    this.size = size;
    Object.freeze(this);
  }

  static all(): CandidateSet {
    return new CandidateSet(new Uint8Array(CANDIDATE_BYTES).fill(255));
  }

  static empty(): CandidateSet {
    return new CandidateSet(new Uint8Array(CANDIDATE_BYTES));
  }

  static fromBytes(value: Uint8Array | ArrayBuffer): CandidateSet {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.byteLength !== CANDIDATE_BYTES) throw new RangeError('候選 bitset 須為 630 bytes。');
    return new CandidateSet(new Uint8Array(bytes));
  }

  static fromIds(ids: Iterable<number>): CandidateSet {
    const bits = new Uint8Array(CANDIDATE_BYTES);
    for (const id of ids) {
      assertId(id);
      bits[id >>> 3] = bits[id >>> 3]! | (1 << (id & 7));
    }
    return new CandidateSet(bits);
  }

  has(id: number): boolean {
    assertId(id);
    return (this.#bits[id >>> 3]! & (1 << (id & 7))) !== 0;
  }

  ids(): number[] {
    const result: number[] = [];
    for (let byteId = 0; byteId < CANDIDATE_BYTES; byteId++) {
      const byte = this.#bits[byteId]!;
      if (byte === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (1 << bit)) !== 0) result.push(byteId * 8 + bit);
      }
    }
    return result;
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#bits);
  }

  intersect(other: CandidateSet): CandidateSet {
    const bits = new Uint8Array(CANDIDATE_BYTES);
    for (let i = 0; i < CANDIDATE_BYTES; i++) bits[i] = this.#bits[i]! & other.#bits[i]!;
    return new CandidateSet(bits);
  }

  equals(other: CandidateSet): boolean {
    return this.size === other.size && this.#bits.every((byte, i) => byte === other.#bits[i]);
  }
}

function assertId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= CANDIDATE_COUNT) {
    throw new RangeError('候選索引超出範圍。');
  }
}

export interface Observation {
  readonly guess: string;
  readonly feedback: Feedback;
}

export function filterCandidates(candidates: CandidateSet, guess: unknown, feedback: Feedback): CandidateSet {
  const id = codeId(guess);
  const { a, b } = parseFeedback(feedback);
  const expected = a * 5 + b;
  return CandidateSet.fromIds(candidates.ids().filter(candidate => scoreIdsUnchecked(candidate, id) === expected));
}

export function candidatesForHistory(history: readonly Observation[]): CandidateSet {
  let candidates = CandidateSet.all();
  // Do not return early: invalid later inputs must still be rejected.
  for (const { guess, feedback } of history) candidates = filterCandidates(candidates, guess, feedback);
  return candidates;
}
