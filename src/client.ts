import { Buffer } from "node:buffer";

import { parsePpgConnectionString } from "./url.ts";
import { deserializeRawResult, type RawResponse } from "./response.ts";
import type { Queryable } from "./sql.ts";

export interface ClientOptions {
  /**
   * Prisma Postgres URL.
   */
  connectionString: string;

  /**
   * Prisma version to use to execute the query.
   */
  prismaVersion?: string;

  /**
   * Prisma query engine SHA-256 commit hash that corresponds to the specified `prismaVersion`.
   */
  engineVersion?: string;
}

const DEFAULT_PRISMA_VERSION = "6.8.0";
const DEFAULT_ENGINE_VERSION = "2060c79ba17c6bb9f5823312b6f6b7f4a845738e";

const schemaStub = `\
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
`;

const schemaHashBinary = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(schemaStub),
);

const schemaHashString = Buffer.from(schemaHashBinary).toString("hex");

const base64Schema = Buffer.from(schemaStub).toString("base64");

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 50;

interface QueryResponse {
  rawText: string;
  data: unknown;
}

/**
 * Error that occurred when executing a query.
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

/**
 * Low level HTTP client interface.
 *
 * ```ts
 * const client = new Client({
 *   connectionString: "prisma+postgres://accelerate.prisma-data.net/?api_key=..."
 * });
 *
 * const user = await client.query(`SELECT * FROM "users" WHERE id = $1`, [1]);
 * ```
 */
export class Client implements Queryable {
  #queryEndpoint: URL;
  #schemaEndpoint: URL;
  #headers: Headers;

  constructor(options: ClientOptions) {
    const { baseUrl, apiKey } = parsePpgConnectionString(
      options.connectionString,
    );

    const prismaVersion = options.prismaVersion ?? DEFAULT_PRISMA_VERSION;
    const engineVersion = options.engineVersion ?? DEFAULT_ENGINE_VERSION;

    this.#headers = new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Prisma-Engine-Hash": engineVersion,
    });

    this.#queryEndpoint = new URL(
      `/${prismaVersion}/${schemaHashString}/graphql`,
      baseUrl,
    );

    this.#schemaEndpoint = new URL(
      `/${prismaVersion}/${schemaHashString}/schema`,
      baseUrl,
    );
  }

  async query(query: string, parameters: unknown[]): Promise<unknown> {
    const response = await this.#request({
      model: null,
      action: "queryRaw",
      query: {
        arguments: { query, parameters },
        selection: {},
      },
    });
    const responseData = response.data as Record<string, unknown>;

    if (!("queryRaw" in responseData)) {
      throw new RequestError(
        `Invalid response shape (missing \`queryRaw\`): ${response.rawText}`,
      );
    }

    return deserializeRawResult(responseData.queryRaw as RawResponse);
  }

  async #request(
    jsonProtocolQuery: unknown,
    tryCount = 0,
  ): Promise<QueryResponse> {
    const response = await fetch(this.#queryEndpoint, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(jsonProtocolQuery),
    });

    if (!response.ok) {
      const responseText = await response.text();
      let responseJson: Record<string, unknown>;

      try {
        responseJson = JSON.parse(responseText);
      } catch {
        throw new RequestError(responseText, response.status);
      }

      if (
        "EngineNotStarted" in responseJson &&
        (responseJson.EngineNotStarted as Record<string, unknown>).reason ===
          "SchemaMissing"
      ) {
        await this.#uploadSchema();
        return await this.#request(jsonProtocolQuery, tryCount + 1);
      }

      // Accelerate API expects the client to retry on transient errors.
      // Prisma Client retries on any 5xx response, but perhaps we could be more specific in the future (e.g. only 503).
      if (response.status >= 500 && tryCount < MAX_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return await this.#request(jsonProtocolQuery, tryCount + 1);
      }

      throw new RequestError(responseText, response.status);
    }

    const responseText = await response.text();
    let responseJson: Record<string, unknown>;

    try {
      responseJson = JSON.parse(responseText);
    } catch {
      throw new RequestError(`Response is not valid JSON: ${responseText}`);
    }

    if ("errors" in responseJson) {
      throw new RequestError(
        `Error in query: ${JSON.stringify(responseJson.errors)}`,
      );
    }

    if (!("data" in responseJson)) {
      throw new RequestError(
        `Invalid response shape (missing \`data\`): ${responseText}`,
      );
    }

    return {
      rawText: responseText,
      data: responseJson.data,
    };
  }

  async #uploadSchema() {
    const response = await fetch(this.#schemaEndpoint, {
      method: "PUT",
      headers: this.#headers,
      body: base64Schema,
    });

    if (!response.ok) {
      throw new RequestError(
        `Schema stub upload failed: ${await response.text()}`,
        response.status,
      );
    }
  }
}
