/** A refusal of the request, with the HTTP status that says so. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What went wrong, in words: an error's message, or the thing itself as text. */
export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
