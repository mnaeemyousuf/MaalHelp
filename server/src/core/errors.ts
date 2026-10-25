/** Application error with a stable machine-readable code and HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (entity = 'Record') => new AppError(404, 'NOT_FOUND', `${entity} not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const insufficientStock = (message = 'Insufficient available stock.', details?: unknown) =>
  new AppError(409, 'INSUFFICIENT_STOCK', message, details);
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const limitReached = (message: string) => new AppError(402, 'PLAN_LIMIT_REACHED', message);

/** Postgres error codes we translate into friendly API errors. */
export function translateDbError(err: unknown): AppError | null {
  const e = err as { code?: string; constraint?: string; detail?: string; message?: string; cause?: unknown };
  const source = (e?.code ? e : (e?.cause as typeof e)) ?? e;
  switch (source?.code) {
    case '23505':
      return conflict('DUPLICATE', duplicateMessage(source.constraint ?? source.detail ?? ''));
    case '23503':
      return badRequest('A referenced record does not exist or belongs to another company.');
    case '23514':
      if (String(source.constraint ?? source.message).includes('non_negative')) return insufficientStock();
      return badRequest('A value is outside the allowed range.');
    case '42501':
      return new AppError(403, 'IMMUTABLE_RECORD', 'This record is append-only and cannot be modified.');
    default:
      return null;
  }
}

function duplicateMessage(constraint: string): string {
  if (constraint.includes('sku')) return 'A product with this SKU already exists.';
  if (constraint.includes('barcode')) return 'This barcode is already assigned.';
  if (constraint.includes('email')) return 'An account already exists for this email.';
  if (constraint.includes('code')) return 'This code is already in use.';
  return 'A record with these details already exists.';
}
