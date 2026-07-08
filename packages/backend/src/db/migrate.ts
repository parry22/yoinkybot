import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
