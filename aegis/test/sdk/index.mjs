// Local stand-in for Telegram Serverless' `sdk` module (see docs/tgcloud-sdk.md).
export { db } from './db.mjs';
export { api, BotApiError, InputFile } from './api.mjs';
export { fetch } from './fetch.mjs';

export class EndpointError extends Error {
  constructor(description, parameters) {
    super(description);
    this.description = description;
    this.parameters = parameters;
  }
}
