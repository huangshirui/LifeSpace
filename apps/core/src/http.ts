export function success<T>(data: T): { data: T } {
  return { data };
}

export function failure(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502) {
    super(message);
  }
}
