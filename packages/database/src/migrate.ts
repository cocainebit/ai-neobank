import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const migrationsUrl = new URL("../migrations/", import.meta.url);
  const files = (await readdir(migrationsUrl)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const [existing] = await sql<{ exists: boolean }[]>`select exists(select 1 from schema_migrations where name = ${file}) as exists`;
    if (existing?.exists) continue;
    const migration = await readFile(new URL(file, migrationsUrl), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    console.log(`Applied ${file}`);
  }
} finally {
  await sql.end();
}
