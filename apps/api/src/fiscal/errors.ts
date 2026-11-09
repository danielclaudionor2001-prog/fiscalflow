export class FiscalError extends Error {
  readonly code: string;
  readonly diagnostico?: Record<string, unknown>;

  constructor(code: string, message: string, diagnostico?: Record<string, unknown>) {
    super(message);
    this.name = "FiscalError";
    this.code = code;
    this.diagnostico = diagnostico;
  }
}

export const maxXmlBytes = 2 * 1024 * 1024;
export const maxPfxBytes = 1024 * 1024;
