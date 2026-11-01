import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

export async function sendMail(to: string, subject: string, text: string) {
  if (!transport) {
    console.log(`[e-mail] ${to} | ${subject}\n${text}`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, to, subject, text });
}
