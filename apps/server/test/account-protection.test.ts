import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/http/app';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { loadEnv } from '../src/config/env';
import { userSettings, users } from '../src/db/schema';
import { getWallet } from '../src/billing/wallet';

/*
 * Public-launch protection: invite-only sign-up, bot check (Turnstile, mocked), email verification
 * before buying credits, no free credits and a daily cap by default in production, and a server
 * that refuses to start with unsafe production settings.
 */

describe('account protection', () => {
  let h: TestHarness;
  let app: FastifyInstance;
  const mock = createMockFetch();
  const emails: string[] = [];
  beforeAll(async () => {
    mock.on('POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', (c) => ({ json: { success: (c.body as { response: string }).response === 'human-ok' } }));
    h = await createTestContext({
      fetch: mock.fetch,
      env: { SIGNUP_MODE: 'invite', SIGNUP_ALLOWLIST: 'giorgi@pijilo.ge, @team.pijilo.ge', REQUIRE_EMAIL_VERIFICATION: 'true', TURNSTILE_SECRET_KEY: 'ts_secret', TURNSTILE_SITE_KEY: 'ts_site', SIGNUP_BONUS_CREDITS: '0', DEFAULT_DAILY_SPEND_LIMIT: '500', PAYMENT_PROVIDER: 'sandbox' },
    });
    // Capture verification emails (console provider logs them).
    h.ctx.log = { ...h.ctx.log, info: (m: string) => void emails.push(m) };
    app = await buildApp(h.ctx);
  });
  afterAll(async () => {
    await app.close();
    await h.close();
  });

  const register = (email: string, turnstileToken?: string) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password1234', name: 'Giorgi', acceptTerms: true, turnstileToken } });

  it('invite-only sign-up with a bot check; no free credits; a daily cap; email verification before paying', async () => {
    expect((await register('giorgi@pijilo.ge')).statusCode).toBe(400); // no Turnstile token
    expect((await register('giorgi@pijilo.ge', 'bot')).json().error.code).toBe('bot_check_failed');
    expect((await register('stranger@gmail.com', 'human-ok')).statusCode).toBe(403); // not invited
    const ok = await register('giorgi@pijilo.ge', 'human-ok');
    expect(ok.statusCode).toBe(201);
    expect((await register('nino@team.pijilo.ge', 'human-ok')).statusCode).toBe(201); // invited domain
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    const id = ok.json().user.id as string;

    expect((await getWallet(h.ctx.db, id)).balance).toBe(0);
    const [s] = await h.ctx.db.select().from(userSettings).where(eq(userSettings.userId, id));
    expect(s!.dailySpendLimit).toBe(500);

    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ verificationRequired: true, user: { emailVerified: false } });
    const buy = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie }, payload: { kind: 'credits', productKey: 'credits_500', idempotencyKey: 'buy-1-xxxx' } });
    expect(buy.statusCode).toBe(403);
    expect(buy.json().error.code).toBe('email_unverified');

    // The emailed link verifies the address once.
    const link = emails.join('\n').match(/verify-email\?token=([\w-]+)/)?.[1];
    expect(link).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: 'x'.repeat(40) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: link } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: link } })).statusCode).toBe(400); // single use
    const [u] = await h.ctx.db.select().from(users).where(eq(users.id, id));
    expect(u!.emailVerifiedAt).not.toBeNull();
    const buy2 = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie }, payload: { kind: 'credits', productKey: 'credits_500', idempotencyKey: 'buy-2-xxxx' } });
    expect(buy2.json().error?.code).not.toBe('email_unverified');

    // Sign-in also needs the bot check; the status endpoint tells the web app which site key to use.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'giorgi@pijilo.ge', password: 'password1234' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'giorgi@pijilo.ge', password: 'password1234', turnstileToken: 'human-ok' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/system/status' })).json()).toMatchObject({ signupMode: 'invite', turnstileSiteKey: 'ts_site', signupBonusCredits: 0 });
  });

  it('production refuses unsafe settings and is strict by default', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(40), STORAGE_SIGNING_SECRET: 't'.repeat(40), DATABASE_URL: 'postgres://u:p@db/framecraft', DEV_FIXTURES_ENABLED: 'false' };
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'console' })).toThrow(/EMAIL_PROVIDER=resend/);
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', SIGNUP_MODE: 'open' })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', PAYMENT_PROVIDER: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
    const env = loadEnv({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' });
    expect(env).toMatchObject({ SIGNUP_BONUS_CREDITS: 0, SIGNUP_MODE: 'invite', REQUIRE_EMAIL_VERIFICATION: true, DEFAULT_DAILY_SPEND_LIMIT: 1000, cookieSecure: true, devFixturesEnabled: false });
  });
});
