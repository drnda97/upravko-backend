import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { buildingAccess } from './access.js';
import { verifyAccess } from './auth.js';

// Događaji nose samo ID-eve. Klijent posle povuče podatke preko REST-a,
// pa autorizacija ostaje na jednom mestu i ništa privatno ne ide kroz sobu zgrade.
export type RealtimeEvent = 'budget' | 'issues' | 'issue' | 'announcements' | 'memberships' | 'threads';

let io: Server | null = null;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.corsOrigins.length ? config.corsOrigins : true } });
  io.use((socket, next) => {
    try {
      socket.data.userId = verifyAccess(String(socket.handshake.auth.token ?? ''));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.on('building:join', async (buildingId: string, ack?: (ok: boolean) => void) => {
      try {
        await buildingAccess(socket.data.userId, String(buildingId));
        for (const room of socket.rooms) if (room.startsWith('building:')) socket.leave(room);
        socket.join(`building:${buildingId}`);
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });
  });
  return io;
}

export const closeRealtime = () => io?.close();

export function toBuilding(buildingId: string, event: RealtimeEvent, id?: string) {
  io?.to(`building:${buildingId}`).emit('change', { event, id });
}

export function toUsers(userIds: string[], event: RealtimeEvent, id?: string) {
  for (const uid of userIds) io?.to(`user:${uid}`).emit('change', { event, id });
}
