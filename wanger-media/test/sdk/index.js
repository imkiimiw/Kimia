// Local stand-in for Telegram Serverless' `sdk` module (docs/tgcloud-sdk.md).
export { db } from './db.js';
export { api, BotApiError, InputFile } from './api.js';
export { fetch } from './fetch.js';

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    if (typeof description !== 'string') throw new TypeError('EndpointError description must be a string');
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
  }
}
