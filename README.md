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

The recommended API for most users is the `ppg` function, which returns
a high-level SQL client implemented as a template literal tag function:

```ts
import { ppg } from "@prisma/ppg";

const sql = ppg("prisma+postgres://accelerate.prisma-data.net/?api_key=...");

const userId = 1;
const posts = await sql`SELECT * FROM posts WHERE user_id = ${userId}`;
```

The interpolated values are automatically converted to SQL parameters to
prevent SQL injection attacks.

For low level control, use the `Client` class directly:

```ts
import { Client } from "@prisma/ppg";

const client = new Client({
  connectionString: "prisma+postgres://accelerate.prisma-data.net/?api_key=...",
});

const posts = await client.query("SELECT * FROM posts WHERE user_id = $1", [1]);
```

## Limitations

Transactions are not currently supported.

## License

Apache-2.0
