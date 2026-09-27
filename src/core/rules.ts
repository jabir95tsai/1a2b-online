declare const codeBrand: unique symbol;
export type Code = string & { readonly [codeBrand]: true };

export interface Feedback {
  readonly a: number;
  readonly b: number;
}

export class RuleError extends Error {
  readonly code: 'INVALID_CODE' | 'INVALID_FEEDBACK';

  constructor(code: RuleError['code']) {
    super(code === 'INVALID_CODE'
      ? '請輸入四位互不重複的半形數字（可為 0 開頭，不含空白）。'
      : '回饋須為非負整數、A+B 不超過 4，且不能為 3A1B。');
    this.name = 'RuleError';
    this.code = code;
  }
}

export function parseCode(value: unknown): Code {
  if (typeof value !== 'string' || value.length !== 4 || !/^[0-9]{4}$/.test(value)
      || new Set(value).size !== 4) {
    throw new RuleError('INVALID_CODE');
  }
  return value as Code;
}

export function parseFeedback(value: unknown): Feedback {
  if (typeof value !== 'object' || value === null || !('a' in value) || !('b' in value)) {
    throw new RuleError('INVALID_FEEDBACK');
  }
  const { a, b } = value;
  if (typeof a !== 'number' || typeof b !== 'number'
      || !Number.isInteger(a) || !Number.isInteger(b)
      || a < 0 || b < 0 || a + b > 4 || (a === 3 && b === 1)) {
    throw new RuleError('INVALID_FEEDBACK');
  }
  return Object.freeze({ a, b });
}

export const VALID_FEEDBACKS: readonly Feedback[] = Object.freeze(
  Array.from({ length: 5 }, (_, a) =>
    Array.from({ length: 5 - a }, (_, b) => Object.freeze({ a, b })))
    .flat().filter(({ a, b }) => !(a === 3 && b === 1)),
);

export function feedbackKey(feedback: Feedback): string {
  const { a, b } = parseFeedback(feedback);
  return `${a}A${b}B`;
}

/** Public scoring boundary: validate both inputs; never coerce a number to a code. */
export function score(answer: unknown, guess: unknown): Feedback {
  const validAnswer = parseCode(answer);
  const validGuess = parseCode(guess);
  let a = 0;
  let common = 0;
  for (let position = 0; position < 4; position++) {
    if (validAnswer[position] === validGuess[position]) a++;
    if (validAnswer.includes(validGuess[position]!)) common++;
  }
  return Object.freeze({ a, b: common - a });
}
