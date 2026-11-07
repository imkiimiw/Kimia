// Local stand-in for Telegram Serverless' `sdk` module (see docs/tgcloud-sdk.md).
export { db } from './db.mjs';
export { api, BotApiError, InputFile } from './api.mjs';
export { fetch } from './fetch.mjs';

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    if (typeof description !== 'string') throw new TypeError('EndpointError description must be a string');
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
  }
}
