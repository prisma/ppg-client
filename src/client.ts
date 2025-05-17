import type { QueryResponse, Queryable } from "./queryable.ts";
import { parsePpgConnectionString } from "./url.ts";

/**
 * Client configuration options.
 */
export interface ClientOptions {
  /**
   * Prisma Postgres URL.
   */
  connectionString: string;
}

/**
 * Generic error that occurred when sending the request or executing a query.
 */
export class RequestError extends Error {
  constructor(message: string, httpCode?: number) {
    if (httpCode !== undefined) {
      super(`HTTP ${httpCode}: ${message}`);
    } else {
      super(message);
    }

    this.name = "RequestError";
  }
}

interface PostgresError {
  error: string;
  severity_local: string;
  severity: string;
  code: string;
  position?: string;
  file: string;
  line: string;
  routine: string;
}

/**
 * Error in the database query.
 */
export class SqlError extends RequestError {
  error: string;
  severityLocal: string;
  severity: string;
  code: string;
  position?: string;
  file: string;
  line: string;
  routine: string;

  constructor(pgError: PostgresError) {
    super(pgError.error);
    this.error = pgError.error;
    this.severityLocal = pgError.severity_local;
    this.severity = pgError.severity;
    this.code = pgError.code;
    this.position = pgError.position;
    this.file = pgError.file;
    this.line = pgError.line;
    this.routine = pgError.routine;
  }
}

const API_ENDPOINT = "https://migrations.prisma-data.net/db/exec";

/**
 * Low level HTTP client interface.
 *
 * ```ts
 * const client = new Client({
 *   connectionString: "prisma+postgres://accelerate.prisma-data.net/?api_key=..."
 * });
 *
 * const { columns, rows } = await client.query(`SELECT * FROM "users" WHERE id = $1`, [1]);
 * ```
 */
export class Client implements Queryable {
  #headers: Headers;

  constructor(options: ClientOptions) {
    const { apiKey } = parsePpgConnectionString(options.connectionString);

    this.#headers = new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  }

  /**
   * Executes a query against the Prisma Postgres database.
   */
  async query(query: string, parameters: unknown[]): Promise<QueryResponse> {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify({ query, parameters }),
    });

    if (response.ok) {
      return (await response.json()) as QueryResponse;
    }

    const errorText = await response.text();
    let errorJson: unknown;

    try {
      errorJson = JSON.parse(errorText);
    } catch {
      throw new RequestError(errorText, response.status);
    }

    if (
      typeof errorJson === "object" &&
      errorJson !== null &&
      "error" in errorJson &&
      "severity_local" in errorJson &&
      "severity" in errorJson &&
      "code" in errorJson &&
      "file" in errorJson &&
      "line" in errorJson &&
      "routine" in errorJson
    ) {
      throw new SqlError(errorJson as PostgresError);
    }

    throw new RequestError(errorText, response.status);
  }
}
