export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = String(code);
    this.details = details;
  }
}
