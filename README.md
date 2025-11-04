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

## Prisma Postgres Direct TCP Connection URL

**Important**: This client requires a **Prisma Postgres Direct TCP Connection** URL. This URL format is specific to Prisma Postgres and has the following structure:

```
postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require
```

You can find this connection string in the API Keys section of your Prisma Postgres dashboard. Other standard PostgreSQL connection strings will not work with this client.

## Quick Start

```ts
import { prismaPostgres, defaultClientConfig } from "@prisma/ppg";

const ppg = prismaPostgres(
  defaultClientConfig(process.env.PRISMA_DIRECT_TCP_URL!)
);

// SQL template literals with automatic parameterization
const users = await ppg.sql<User>`SELECT * FROM users WHERE id = ${userId}`.collect();
```

## Usage Guide

This library provides two APIs:

1. **`prismaPostgres()`** - High-level API with SQL template literals, transactions, and batch operations (recommended for most users)
2. **`client()`** - Low-level untyped API with explicit parameter passing and session management

---

## High-Level API: `prismaPostgres()`

The `prismaPostgres()` function returns a feature-rich client with SQL template literals, transactions, and batch operations.

### Setup

```ts
import { prismaPostgres, defaultClientConfig } from "@prisma/ppg";

// Recommended: Use defaultClientConfig to include default parsers and serializers
const ppg = prismaPostgres(
  defaultClientConfig("postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require")
);

// Or manually configure (no default parsers/serializers):
const ppgCustom = prismaPostgres({
  connectionString: "postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require",
  parsers: [/* your custom parsers */],
  serializers: [/* your custom serializers */]
});
```

> **Important**: Use `defaultClientConfig()` to automatically include default parsers and serializers for common PostgreSQL types (Date, JSON, BigInt, etc.). Without it, you'll need to manually configure parsers and serializers.

### Query Modes

#### 1. SQL Template Literals - Async Iterator

Execute queries using tagged template literals. Values are automatically parameterized to prevent SQL injection.

```ts
type User = { id: string; name: string; email: string };

const users = ppg.sql<User>`SELECT * FROM users`;

// Stream results one by one
for await (const user of users) {
  console.log(user.id, user.name, user.email);
}
```

#### 2. SQL Template Literals - Collect All Rows

Collect all results into an array:

```ts
const users = await ppg.sql<User>`SELECT * FROM users WHERE email = ${"test@example.com"}`.collect();
console.log(users[0].name);
```

#### 3. SQL Template Literals - Exec Mode

Use `sql.exec` for INSERT, UPDATE, DELETE operations that return affected row counts:

```ts
const affected = await ppg.sql.exec`DELETE FROM users WHERE id = ${userId}`;
console.log(`Deleted ${affected} user(s)`);
```

#### 4. Explicit Parameter Query

Use the `query()` method with explicit positional parameters:

```ts
const users = await ppg.query<User>("SELECT * FROM users WHERE email = $1", "test@example.com").collect();
```

#### 5. Explicit Parameter Exec

Use the `exec()` method for write operations:

```ts
const affected = await ppg.exec("INSERT INTO users (name, email) VALUES ($1, $2)", "Alice", "alice@example.com");
console.log(`Inserted ${affected} row(s)`);
```

### Transactions

#### Interactive Transactions

Execute multiple queries within an automatic transaction. The transaction commits on success or rolls back on error:

```ts
const result = await ppg.transaction(async (tx) => {
  // BEGIN is executed automatically

  await tx.sql.exec`INSERT INTO users (name) VALUES ('Alice')`;

  const users = await tx.sql<User>`SELECT * FROM users WHERE name = 'Alice'`.collect();

  // COMMIT is executed automatically
  return users[0].name;
});

console.log(result); // "Alice"
```

Rollback on error:

```ts
try {
  await ppg.transaction(async (tx) => {
    await tx.sql.exec`INSERT INTO users (name) VALUES ('Bob')`;
    throw new Error("Something went wrong");
    // ROLLBACK is executed automatically
  });
} catch (error) {
  console.log("Transaction rolled back");
}
```

Use `query()` and `exec()` methods within transactions:

```ts
await ppg.transaction(async (tx) => {
  const before = await tx.query<User>("SELECT * FROM users WHERE id = $1", userId).collect();

  await tx.exec("UPDATE users SET name = $1 WHERE id = $2", "New Name", userId);

  const after = await tx.query<User>("SELECT * FROM users WHERE id = $1", userId).collect();
});
```

### Batch Operations

Execute multiple statements in a single round-trip within an automatic transaction.

#### Array Syntax

```ts
const [users, affected, counts] = await ppg.batch<[User[], number, { count: bigint }[]]>(
  { query: "SELECT * FROM users WHERE id < $1", parameters: [5] },
  { exec: "INSERT INTO users (name) VALUES ($1)", parameters: ["Charlie"] },
  { query: "SELECT COUNT(*)::int8 as count FROM users", parameters: [] }
);

console.log(users);        // User[]
console.log(affected);     // number
console.log(counts[0].count); // bigint
```

#### Fluent Builder API

```ts
const [users, affected, counts] = await ppg.batch()
  .query<User>("SELECT * FROM users WHERE id = $1", userId)
  .exec("UPDATE users SET name = $1 WHERE id = $2", "Updated Name", userId)
  .query<{ count: bigint }>("SELECT COUNT(*)::int8 as count FROM users")
  .run();
```

Batch operations are atomic - they rollback automatically on error:

```ts
try {
  await ppg.batch<[number, User[]]>(
    { exec: "INSERT INTO users (name) VALUES ($1)", parameters: ["Dave"] },
    { query: "SELECT * FROM invalid_table", parameters: [] } // Fails
  );
} catch (error) {
  // First insert is rolled back
}
```

### Type Support

When using `defaultClientConfig()`, the client automatically handles PostgreSQL types:

```ts
import { prismaPostgres, defaultClientConfig } from "@prisma/ppg";

const ppg = prismaPostgres(defaultClientConfig(process.env.DATABASE_URL!));

// JSON/JSONB - automatic parsing
const rows = await ppg.sql<{ data: { key: string } }>`
  SELECT '{"key": "value"}'::jsonb as data
`.collect();
console.log(rows[0].data.key); // "value" (already parsed)

// BigInt - parsed to JavaScript BigInt
const bigints = await ppg.sql<{ big: bigint }>`
  SELECT 9007199254740991::int8 as big
`.collect();
console.log(typeof bigints[0].big); // "bigint"

// Date/Timestamp - parsed to Date objects
const dates = await ppg.sql<{ created: Date }>`
  SELECT NOW() as created
`.collect();
console.log(dates[0].created instanceof Date); // true

// Date serialization - automatic conversion
const testDate = new Date("2024-01-15T10:30:00Z");
await ppg.sql.exec`INSERT INTO events (timestamp) VALUES (${testDate})`;

// Null handling
const rows2 = await ppg.sql<{ id: number | null; name: string | null }>`
  SELECT NULL::int as id, 'test'::text as name
`.collect();
```

#### Default Type Mappings

With `defaultClientConfig()`, the following types are automatically parsed:

| PostgreSQL Type | JavaScript Type | OID |
|----------------|-----------------|-----|
| `boolean` | `boolean` | 16 |
| `int2`, `int4` | `number` | 21, 23 |
| `int8` | `bigint` | 20 |
| `float4`, `float8` | `number` | 700, 701 |
| `text`, `varchar` | `string` | 25, 1043 |
| `json`, `jsonb` | `object` | 114, 3802 |
| `date` | `Date` | 1082 |
| `time` | `string` | 1083 |
| `timestamp` | `Date` | 1114 |
| `timestamptz` | `Date` | 1184 |

---

## Low-Level API: `client()`

The `client()` function provides direct control over query execution and session management.

### Setup

```ts
import { client, defaultClientConfig } from "@prisma/ppg";

// Recommended: Use defaultClientConfig to include default parsers and serializers
const cl = client(
  defaultClientConfig("postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require")
);

// Or manually configure:
const clCustom = client({
  connectionString: "postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require",
  parsers: [/* your custom parsers */],
  serializers: [/* your custom serializers */]
});
```

> **Important**: Use `defaultClientConfig()` to get automatic type parsing (Date, JSON, BigInt, etc.) and serialization (Date, BigInt, Number).

### Query Modes

#### 1. Simple Query

```ts
const result = await cl.query("SELECT * FROM users WHERE id = $1", userId);

console.log(result.columns); // Column metadata
const rows = await result.rows.collect(); // Collect all rows
console.log(rows[0].values); // Access row values as array
```

#### 2. Exec for Write Operations

```ts
const affected = await cl.exec("INSERT INTO users (name, email) VALUES ($1, $2)", "Alice", "alice@example.com");
console.log(`Affected ${affected} rows`);
```

#### 3. Async Iteration

```ts
const result = await cl.query("SELECT * FROM users");

for await (const row of result.rows) {
  console.log(row.values); // Process one row at a time
}
```

### Sessions

Sessions provide stateful connections for transactions and sequential operations.

#### Creating and Using Sessions

```ts
const session = await cl.newSession();

// Execute queries in the session
const result = await session.query("SELECT 1");
const rows = await result.rows.collect();

// Close the session when done
session.close();
```

#### Using Declaration (Automatic Cleanup)

```ts
{
  using session = await cl.newSession();

  await session.query("SELECT 1");

  // Session automatically closes when leaving scope
}
```

#### Manual Transactions with Sessions

```ts
const session = await cl.newSession();

await session.query("BEGIN");
try {
  await session.query("INSERT INTO users (name) VALUES ($1)", "Alice");
  const result = await session.query("SELECT * FROM users WHERE name = $1", "Alice");
  await session.query("COMMIT");
} catch (error) {
  await session.query("ROLLBACK");
  throw error;
} finally {
  session.close();
}
```

#### Concurrent Queries in Session

Sessions can handle concurrent queries via WebSocket multiplexing:

```ts
const session = await cl.newSession();

const [res1, res2, res3] = await Promise.all([
  session.query("SELECT 1"),
  session.query("SELECT 2"),
  session.query("SELECT 3")
]);

const rows1 = await res1.rows.collect();
const rows2 = await res2.rows.collect();
const rows3 = await res3.rows.collect();

session.close();
```

### Result Handling

#### Column Metadata

```ts
const result = await cl.query("SELECT id, name FROM users");

result.columns.forEach(col => {
  console.log(col.name);  // Column name
  console.log(col.oid);   // PostgreSQL type OID
});
```

#### Row Values

```ts
const result = await cl.query("SELECT id, name FROM users");
const rows = await result.rows.collect();

rows.forEach(row => {
  const [id, name] = row.values;
  console.log(id, name);
});
```

### Custom Type Handling

#### Custom Parsers

You can override or add parsers on top of the defaults:

```ts
import { client, defaultClientConfig } from "@prisma/ppg";
import type { ValueParser } from "@prisma/ppg";

const uuidParser: ValueParser<string> = {
  oid: 2950, // UUID type OID
  parse: (value: string | null) => value ? value.toUpperCase() : null
};

const config = defaultClientConfig("postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require");
const cl = client({
  ...config,
  parsers: [...config.parsers, uuidParser], // Add to defaults
});

// Or replace defaults entirely:
const clCustom = client({
  connectionString: "postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require",
  parsers: [uuidParser], // Only your custom parsers
});
```

#### Custom Serializers

Add custom serializers on top of defaults:

```ts
import { client, defaultClientConfig } from "@prisma/ppg";
import type { ValueSerializer } from "@prisma/ppg";

class Point { constructor(public x: number, public y: number) {} }

const pointSerializer: ValueSerializer<Point> = {
  supports: (value: unknown): value is Point => value instanceof Point,
  serialize: (value: Point) => `(${value.x},${value.y})`
};

const config = defaultClientConfig("postgres://tenantId:key@db.prisma.io:5432/postgres?sslmode=require");
const cl = client({
  ...config,
  serializers: [pointSerializer, ...config.serializers], // Your serializer first
});

await cl.query("INSERT INTO locations (point) VALUES ($1)", new Point(10, 20));
```

> **Note**: Custom serializers are checked in order. Put your custom serializers before defaults so they take precedence.

### Binary Parameters

Send binary data efficiently:

```ts
import { byteArrayParameter, boundedByteStreamParameter, BINARY, TEXT } from "@prisma/ppg";

// From Uint8Array
const bytes = new Uint8Array([1, 2, 3, 4]);
const param = byteArrayParameter(bytes, BINARY);
await cl.query("INSERT INTO files (data) VALUES ($1)", param);

// From ReadableStream
const stream = getReadableStream();
const streamParam = boundedByteStreamParameter(stream, BINARY, 1024);
await cl.query("INSERT INTO files (data) VALUES ($1)", streamParam);
```

---

## Error Handling

The library provides a structured error hierarchy:

```ts
import {
  GenericError,       // Base error class
  ValidationError,    // Invalid input or configuration
  HttpResponseError,  // HTTP transport errors
  WebSocketError,     // WebSocket transport errors
  DatabaseError       // PostgreSQL errors
} from "@prisma/ppg";

try {
  await ppg.sql`SELECT * FROM invalid_table`.collect();
} catch (error) {
  if (error instanceof DatabaseError) {
    console.log(error.code);    // PostgreSQL error code (e.g., "42P01")
    console.log(error.details); // Additional error details
  }
}
```

---

## API Reference

### `defaultClientConfig(connectionString: string | URL): ClientConfig`

Creates a client configuration with default parsers and serializers.

Returns:
- `connectionString: string` - The connection URL
- `parsers: ValueParser<unknown>[]` - Default type parsers (Date, JSON, BigInt, etc.)
- `serializers: ValueSerializer<unknown>[]` - Default type serializers (Date, BigInt, Number)

```ts
import { prismaPostgres, defaultClientConfig } from "@prisma/ppg";

const ppg = prismaPostgres(defaultClientConfig(process.env.DATABASE_URL!));
```

### `prismaPostgres(config: PrismaPostgresConfig): PrismaPostgres`

Configuration:
- `connectionString: string` - PostgreSQL connection URL
- `parsers?: ValueParser<unknown>[]` - Custom type parsers (use `defaultClientConfig` for defaults)
- `serializers?: ValueSerializer<unknown>[]` - Custom type serializers (use `defaultClientConfig` for defaults)

Returns:
- `sql` - SQL template literal tag
- `sql.exec` - SQL template literal for exec operations
- `query<R>(sql, ...params): CollectableIterator<R>` - Execute query with explicit parameters
- `exec(sql, ...params): Promise<number>` - Execute command with explicit parameters
- `transaction<T>(callback): Promise<T>` - Execute interactive transaction
- `batch(...statements)` - Execute batch operations
- `batch()` - Start fluent batch builder

### `client(config: ClientConfig): Client`

Configuration:
- `connectionString: string` - PostgreSQL connection URL
- `parsers?: ValueParser<unknown>[]` - Custom type parsers (use `defaultClientConfig` for defaults)
- `serializers?: ValueSerializer<unknown>[]` - Custom type serializers (use `defaultClientConfig` for defaults)

Returns:
- `query(sql, ...params): Promise<Resultset>` - Execute query
- `exec(sql, ...params): Promise<number>` - Execute command
- `newSession(config?: SessionConfig): Promise<Session>` - Create new session

### Types

```ts
interface CollectableIterator<T> extends AsyncIterableIterator<T> {
  collect(): Promise<T[]>;
}

interface Resultset {
  columns: Column[];
  rows: CollectableIterator<Row>;
}

interface Row {
  values: unknown[];
}

interface Column {
  name: string;
  oid: number;
}

interface Session extends Statements, Disposable {
  readonly active: boolean;
  close(): void;
}
```

---

## License

Apache-2.0