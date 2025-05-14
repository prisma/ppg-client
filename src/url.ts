export class ConnectionStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionStringError";
  }
}

export interface ConnectionString {
  baseUrl: URL;
  apiKey: string;
}

export function parsePpgConnectionString(
  connectionString: string,
): ConnectionString {
  const url = new URL(connectionString);

  if (url.protocol !== "prisma+postgres:") {
    throw new ConnectionStringError("Invalid protocol");
  }

  const apiKey = url.searchParams.get("api_key");
  if (!apiKey) {
    throw new ConnectionStringError("Missing API key");
  }

  let baseUrl: URL;

  if (isLocalhost(url.hostname)) {
    baseUrl = new URL(`http://${url.host}`);
  } else {
    baseUrl = new URL(`https://${url.host}`);
  }

  return {
    baseUrl,
    apiKey,
  };
}

function isLocalhost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
