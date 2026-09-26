export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = options.status || 500;
    this.type = options.type || "server_error";
    this.code = options.code || this.type;
  }
}

export function errorBody(error) {
  const known = error instanceof ProviderError;
  return {
    error: {
      type: known ? error.type : "server_error",
      code: known ? error.code : "server_error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
