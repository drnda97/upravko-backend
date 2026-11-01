import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from './config.js';

export async function migrate(database = config.db.database) {
  const conn = await mysql.createConnection({ ...config.db, database: undefined, multipleStatements: true });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.query(`USE \`${database}\``);
  await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(190) PRIMARY KEY, applied_at DATETIME NOT NULL)');
  const [applied] = await conn.query('SELECT name FROM schema_migrations');
  const done = new Set((applied as { name: string }[]).map((r) => r.name));
  const dir = path.resolve('migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations VALUES (?, UTC_TIMESTAMP())', [file]);
    console.log('primenjena migracija', file);
  }
  await conn.end();
}

if (process.argv[1]?.endsWith('migrate.ts')) await migrate();
