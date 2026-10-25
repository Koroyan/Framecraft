import type { AppContext } from '../context';

/*
 * Transactional email. `console` (development) prints the message to the server log so links can
 * be opened locally; `resend` sends it through Resend's HTTP API. Production refuses to start with
 * `console` while email verification is on (see config/env.ts).
 */

export type Email = { to: string; subject: string; text: string; html?: string };

export async function sendEmail(ctx: AppContext, m: Email): Promise<void> {
  if (ctx.env.EMAIL_PROVIDER === 'resend' && ctx.env.RESEND_API_KEY) {
    const res = await ctx.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ctx.env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
    });
    if (!res.ok) throw new Error(`Email could not be sent (HTTP ${res.status})`);
    return;
  }
  ctx.log.info(`[email] to=${m.to} subject="${m.subject}"\n${m.text}`);
}
