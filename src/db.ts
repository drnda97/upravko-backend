import mysql, { type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 20,
  timezone: 'Z',
  decimalNumbers: true,
  dateStrings: ['DATE'],
  charset: 'utf8mb4',
  namedPlaceholders: false,
});

export type Db = Pick<PoolConnection, 'query'>;
export type Row = RowDataPacket & Record<string, any>;

export const uuid = () => randomUUID();

export async function rows<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await db.query<RowDataPacket[]>(sql, params);
  return result as T[];
}

export async function one<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(db, sql, params))[0];
}

export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await db.query<ResultSetHeader>(sql, params);
  return result;
}

export async function tx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
