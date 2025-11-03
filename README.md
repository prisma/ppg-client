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

## Quick Start

```ts
import { prismaPostgres } from "@prisma/ppg";

const ppg = prismaPostgres({
  connectionString: process.env.PRISMA_DIRECT_TCP_URL
});

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
import { prismaPostgres } from "@prisma/ppg";

const ppg = prismaPostgres({
  connectionString: "postgres://user:password@host:port/database"
});
```

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

The client handles PostgreSQL types with automatic parsing:

```ts
// JSON/JSONB
const jsonData = { key: "value", nested: { count: 42 } };
await ppg.sql.exec`INSERT INTO data (json_col) VALUES (${JSON.stringify(jsonData)})`;
const rows = await ppg.sql<{ json_col: object }>`SELECT json_col FROM data`.collect();

// BigInt
const bigints = await ppg.sql<{ big: bigint }>`SELECT 9007199254740991::int8 as big`.collect();
console.log(typeof bigints[0].big); // "bigint"

// Date serialization
const testDate = new Date("2024-01-15T10:30:00Z");
await ppg.sql.exec`INSERT INTO events (timestamp) VALUES (${testDate})`;

// Null handling
const rows = await ppg.sql<{ id: number | null; name: string | null }>`
  SELECT NULL::int as id, 'test'::text as name
`.collect();
```

---

## Low-Level API: `client()`

The `client()` function provides direct control over query execution and session management.

### Setup

```ts
import { client } from "@prisma/ppg";

const cl = client({
  connectionString: "postgres://user:password@host:port/database"
});
```

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

Parse PostgreSQL types with custom logic:

```ts
import { client } from "@prisma/ppg";
import type { ValueParser } from "@prisma/ppg";

const uuidParser: ValueParser<string> = {
  oid: 2950, // UUID type OID
  parse: (value: string | null) => value ? value.toUpperCase() : null
};

const cl = client({
  connectionString: "...",
  parsers: [uuidParser]
});
```

#### Custom Serializers

Serialize JavaScript types to PostgreSQL:

```ts
import type { ValueSerializer } from "@prisma/ppg";

class Point { constructor(public x: number, public y: number) {} }

const pointSerializer: ValueSerializer<Point> = {
  supports: (value: unknown): value is Point => value instanceof Point,
  serialize: (value: Point) => `(${value.x},${value.y})`
};

const cl = client({
  connectionString: "...",
  serializers: [pointSerializer]
});

await cl.query("INSERT INTO locations (point) VALUES ($1)", new Point(10, 20));
```

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

### `prismaPostgres(config: PrismaPostgresConfig): PrismaPostgres`

Configuration:
- `connectionString: string` - PostgreSQL connection URL
- `parsers?: ValueParser<unknown>[]` - Custom type parsers
- `serializers?: ValueSerializer<unknown>[]` - Custom type serializers

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
- `parsers?: ValueParser<unknown>[]` - Custom type parsers
- `serializers?: ValueSerializer<unknown>[]` - Custom type serializers

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