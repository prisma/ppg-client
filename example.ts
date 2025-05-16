import assert from "node:assert/strict";

import ppg from "./src/index.ts";

const sql = ppg(process.env.E2E_PPG_URL!);

await sql`create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null
)`;

await sql`insert into users (email, name) values ('test@example.com', 'Test User') on conflict do nothing`;

type User = {
  id: string;
  email: string;
  name: string;
};

const users: User[] = await sql`select * from users`;

console.log(users);

const [user1] =
  await sql<User>`select * from users where email = ${"test@example.com"}`;

const [user2] = await sql.query<User>("select * from users where email = $1", [
  "test@example.com",
]);

assert.equal(user1.id, user2.id);
