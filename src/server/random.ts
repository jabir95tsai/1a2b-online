import { codeAt, CANDIDATE_COUNT } from '../core/candidates.ts';
import type { Code } from '../core/rules.ts';

export function randomAnswer(): Code {
  const limit = Math.floor(0x1_0000_0000 / CANDIDATE_COUNT) * CANDIDATE_COUNT;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0]! >= limit);
  return codeAt(value[0]! % CANDIDATE_COUNT);
}
