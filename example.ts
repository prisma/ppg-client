import { createClient } from "./src/index.ts";

const sql = createClient(process.env.E2E_PPG_URL!);

const text = "hello";
console.log(await sql`select ${text} as t`);
