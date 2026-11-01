import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { exec, pool, rows } from '../db.js';

const expo = new Expo();

export type Push = {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Hitno i podsetnik za uplatu stižu i korisnicima sa podešavanjem "Samo hitna". */
  urgent?: boolean;
};

export async function sendPush(userIds: string[], push: Push) {
  if (!userIds.length) return;
  const targets = await rows(
    pool,
    `SELECT p.token FROM push_tokens p JOIN users u ON u.id = p.user_id
     WHERE p.user_id IN (?) ${push.urgent ? '' : "AND u.notify_pref = 'all'"}`,
    [userIds],
  );
  const messages: ExpoPushMessage[] = targets
    .filter((t) => Expo.isExpoPushToken(t.token))
    .map((t) => ({ to: t.token, sound: 'default', title: push.title, body: push.body, data: push.data }));
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      await Promise.all(
        tickets.map((ticket, i) =>
          ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered'
            ? exec(pool, 'DELETE FROM push_tokens WHERE token = ?', [chunk[i]!.to as string])
            : null,
        ),
      );
    } catch (err) {
      console.error('push nije poslat', err);
    }
  }
}

/** Push je sporedan efekat: nikad ne obara zahtev koji ga je izazvao. */
export const pushLater = (userIds: string[], push: Push) => {
  sendPush(userIds, push).catch((err) => console.error('push nije poslat', err));
};
