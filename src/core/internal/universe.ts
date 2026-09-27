import { parseCode } from '../rules.ts';
import type { Code } from '../rules.ts';

// Sorted immutable universe. No per-game secret or mutable session state is global.
const codes: Code[] = [];
for (let a = 0; a < 10; a++) {
  for (let b = 0; b < 10; b++) {
    if (b === a) continue;
    for (let c = 0; c < 10; c++) {
      if (c === a || c === b) continue;
      for (let d = 0; d < 10; d++) {
        if (d !== a && d !== b && d !== c) codes.push(parseCode(`${a}${b}${c}${d}`));
      }
    }
  }
}

export const ALL_CODES: readonly Code[] = Object.freeze(codes);
export const CANDIDATE_COUNT = ALL_CODES.length;
const ids = new Map(ALL_CODES.map((code, id) => [code, id]));
const packed = new Uint16Array(CANDIDATE_COUNT);
const masks = new Uint16Array(CANDIDATE_COUNT);
const population = new Uint8Array(1024);
for (let i = 1; i < population.length; i++) population[i] = population[i >>> 1]! + (i & 1);
for (let id = 0; id < CANDIDATE_COUNT; id++) {
  const code = ALL_CODES[id]!;
  for (let position = 0; position < 4; position++) {
    const digit = Number(code[position]);
    packed[id] = packed[id]! | (digit << (position * 4));
    masks[id] = masks[id]! | (1 << digit);
  }
}

export function codeId(value: unknown): number {
  return ids.get(parseCode(value))!;
}

export function codeAt(id: number): Code {
  if (!Number.isInteger(id) || id < 0 || id >= CANDIDATE_COUNT) {
    throw new RangeError('候選索引超出範圍。');
  }
  return ALL_CODES[id]!;
}

/** Internal hot path; callers supply IDs from a validated CandidateSet / codeId. */
export function scoreIdsUnchecked(leftId: number, rightId: number): number {
  const difference = packed[leftId]! ^ packed[rightId]!;
  const a = Number((difference & 0x000f) === 0)
    + Number((difference & 0x00f0) === 0)
    + Number((difference & 0x0f00) === 0)
    + Number((difference & 0xf000) === 0);
  const common = population[masks[leftId]! & masks[rightId]!]!;
  // a * 5 + b; 25 slots, including unreachable bins, avoid allocation in minimax.
  return a * 5 + common - a;
}
