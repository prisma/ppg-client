import assert from "node:assert/strict";

import { prismaPostgres } from "./src/index.ts";

const { sql, query } = prismaPostgres({
  connectionString: process.env.PRISMA_DIRECT_TCP_URL!
});

await sql.exec`create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null
)`;

await sql.exec`insert into users (email, name) values ('test@example.com', 'Test User') on conflict do nothing`;

type User = {
  id: string;
  email: string;
  name: string;
};

// async iterator mode
const usersIterator = sql<User>`select * from users`;

for await (const user of usersIterator) {
  console.log(user.id, user.name, user.email);
}

// direct collection mode
const [user1] =
  await sql<User>`select * from users where email = ${"test@example.com"}`.collect();

// explicit parameters
const [user2] = await query<User>("select * from users where email = $1", [
  "test@example.com",
]).collect();

assert.equal(user1.id, user2.id);
