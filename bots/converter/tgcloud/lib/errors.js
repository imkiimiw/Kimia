// A refusal with a code the user sees as a friendly text (`err.<code>` in the locales). Pure.
export class ToolError extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.name = 'ToolError';
    this.code = code;
    this.vars = vars;
  }
}

export const isToolError = (e) => !!e && e.name === 'ToolError' && typeof e.code === 'string';
