import { RuleError } from '../core/rules.ts';
import type { ErrorView } from '../protocol/solo.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Pick<ErrorView['error'], 'turns' | 'irreducible'>;
  constructor(status: number, code: string, message: string,
    details: ApiError['details'] = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function failure(error: unknown): { status: number; body: ErrorView } {
  if (error instanceof ApiError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, ...error.details } } };
  }
  if (error instanceof RuleError) {
    return { status: 400, body: { error: { code: error.code, message: error.message } } };
  }
  // No raw exception, payload, stack, or storage value crosses the public boundary.
  return { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: '服務暫時無法處理，請以相同 requestId 重試。' } } };
}
