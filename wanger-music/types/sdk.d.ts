// Minimal local typings for the platform SDK (the CLI ships none). Editor/type-check use only;
// nothing here is deployed. Covers what this project uses; see docs/tgcloud-sdk.md for the full API.
declare module 'sdk/db' {
  export interface Sql { readonly __sql: true }
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql;
  export namespace sql { function raw(text: string): Sql }
  export interface RunResult { rowsAffected: number; lastInsertRowid: number; rows: any[] }
  export const db: {
    run(query: Sql | string, params?: Record<string, unknown>): Promise<RunResult>;
    all(query: Sql | string, params?: Record<string, unknown>): Promise<any[]>;
    get(query: Sql | string, params?: Record<string, unknown>): Promise<any | null>;
    values(query: Sql | string, params?: Record<string, unknown>): Promise<unknown[][]>;
  };
  export default db;
  type Col = any;
  export function table(name: string, columns: Record<string, Col>, extras?: (t: Record<string, any>) => Record<string, unknown>): any;
  export function integer(name?: string, opts?: { mode?: string }): Col;
  export function text(name?: string, opts?: { mode?: string }): Col;
  export function real(name?: string): Col;
  export function blob(name?: string): Col;
  export function boolean(name?: string): Col;
  export function json(name?: string): Col;
  export function index(name: string): any;
  export function uniqueIndex(name: string): any;
  export function unique(name: string): any;
  export function check(name: string, cond: Sql): any;
  export function primaryKey(o: { columns: any[] }): any;
}

declare module 'sdk' {
  export { db } from 'sdk/db';
  export class BotApiError extends Error {
    code: number;
    description: string;
    method: string;
    parameters?: { retry_after?: number; migrate_to_chat_id?: number };
  }
  export class EndpointError extends Error {
    constructor(description: string, parameters?: Record<string, unknown>);
    description: string;
    parameters: Record<string, unknown>;
  }
  export class InputFile {
    constructor(bytes: Uint8Array | ArrayBuffer, filename: string, opts?: { type?: string });
  }
  /** Telegram Bot API: api.<method>(params) → unwrapped result; throws BotApiError. */
  export const api: Record<string, (params?: Record<string, any>) => Promise<any>> & {
    getFileContent(file: string | { file_id: string }): Promise<Uint8Array>;
  };
  export function fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    status: number; ok: boolean; statusText: string; url: string; json(): Promise<any>; text(): Promise<string>;
  }>;
}

declare module 'sdk/api' { export { api } from 'sdk'; }
declare module 'sdk/fetch' { export { fetch } from 'sdk'; }
