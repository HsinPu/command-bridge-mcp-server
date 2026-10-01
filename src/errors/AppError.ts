export class AppError extends Error {
  rule?: string;
  auditId?: string;
  constructor(
    public readonly code: string,
    message: string,
    public readonly action: string = "Check the CommandBridge service logs before retrying.",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function toErrorPayload(error: unknown) {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        action: error.action,
        ...(error.rule ? { rule: error.rule } : {}),
        ...(error.auditId ? { auditId: error.auditId } : {})
      }
    };
  }

  return {
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "Unexpected error.",
      action: "Check the CommandBridge MCP server logs for more details."
    }
  };
}
