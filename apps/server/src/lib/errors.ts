export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`, 404);
export const forbidden = (msg = 'You do not have access to this resource') => new AppError('forbidden', msg, 403);
export const unauthorized = (msg = 'Please sign in') => new AppError('unauthorized', msg, 401);
export const badRequest = (msg: string, details?: unknown) => new AppError('bad_request', msg, 400, details);
export const conflict = (msg: string) => new AppError('conflict', msg, 409);
export const paymentRequired = (msg: string, details?: unknown) => new AppError('insufficient_credits', msg, 402, details);
export const configurationRequired = (msg: string, details?: unknown) => new AppError('configuration_required', msg, 503, details);
