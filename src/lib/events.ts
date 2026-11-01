import { exec, uuid, type Db } from '../db.js';
import { now } from './clock.js';

export const addEvent = (db: Db, issueId: string, type: string, actor: string | null, payload?: unknown) =>
  exec(db, 'INSERT INTO issue_events (id, issue_id, type, actor_user_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    uuid(), issueId, type, actor, payload ? JSON.stringify(payload) : null, now(),
  ]);
