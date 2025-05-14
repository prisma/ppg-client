# @prisma/ppg

Modern, lightweight, minimal serverless client for [Prisma Postgres®](https://www.prisma.io/postgres?utm_source=github&utm_medium=ppg-client-readme).

## Installation

Install this package using your package manager and registry of choice:

* npm: `npm install @prisma/ppg`
* pnpm: `pnpm add @prisma/ppg` (or `pnpm add jsr:@prisma/ppg`)
* Yarn: `yarn add @prisma/ppg`
* Bun: `bun add @prisma/ppg`
* Deno: `deno add jsr:@prisma/ppg`
* esm.sh CDN: `https://esm.sh/@prisma/ppg`

## Usage

The recommended API for most users is the `createClient` function, which returns
a high-level SQL client implemented as a template literal tag function:

```ts
import { createClient } from "@prisma/ppg";

const sql = createClient("prisma+postgres://accelerate.prisma-data.net/?api_key=...");
const user = await sql`SELECT * FROM users WHERE id = ${id}`;
```

The interpolated values are automatically converted to SQL parameters to
prevent SQL injection attacks.

For low level control, use the `Client` class directly:

```ts
import { Client } from "@prisma/ppg";

const client = new Client({
  connectionString: "prisma+postgres://accelerate.prisma-data.net/?api_key=...",
});

const user = await client.query("SELECT * FROM users WHERE id = $1", [id]);
```

## License

Apache-2.0
