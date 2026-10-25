import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env';
import { signLocal, verifyLocalSignature } from '../src/storage/storage';

const SECRET = 'x'.repeat(40);

describe('environment safety', () => {
  it('development defaults: no paid calls, fixtures on, loopback only', () => {
    const e = loadEnv({ NODE_ENV: 'development' });
    expect(e.LIVE_GENERATION_ENABLED).toBe(false);
    expect(e.devFixturesEnabled).toBe(true);
    expect(e.HOST).toBe('127.0.0.1');
    expect(e.embeddedWorker).toBe(true);
  });

  it('treats empty values as unset', () => {
    expect(() => loadEnv({ NODE_ENV: 'development', SESSION_SECRET: '', RUNWAYML_API_SECRET: '' })).not.toThrow();
    expect(loadEnv({ NODE_ENV: 'development', RUNWAYML_API_SECRET: 'your-runway-key' }).RUNWAYML_API_SECRET).toBeUndefined();
  });

  it('production refuses to start without secrets, Postgres, or with fixtures', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, STORAGE_SIGNING_SECRET: SECRET })).toThrow(/PostgreSQL/);
    expect(() => loadEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, STORAGE_SIGNING_SECRET: SECRET, DATABASE_URL: 'postgres://u:p@db/x', DEV_FIXTURES_ENABLED: 'true' })).toThrow(/DEV_FIXTURES_ENABLED/);
    // Email verification is on in production, so a real email provider is required too.
    expect(() => loadEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, STORAGE_SIGNING_SECRET: SECRET, DATABASE_URL: 'postgres://u:p@db/x' })).toThrow(/EMAIL_PROVIDER=resend/);
    const ok = loadEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, STORAGE_SIGNING_SECRET: SECRET, DATABASE_URL: 'postgres://u:p@db/x', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
    expect(ok.devFixturesEnabled).toBe(false);
    expect(ok.cookieSecure).toBe(true);
  });
});

describe('signed media URLs', () => {
  it('accept valid signatures and reject tampering or expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signLocal(SECRET, 'u/1/a.mp4', exp);
    expect(verifyLocalSignature(SECRET, 'u/1/a.mp4', exp, sig)).toBe(true);
    expect(verifyLocalSignature(SECRET, 'u/2/a.mp4', exp, sig)).toBe(false);
    expect(verifyLocalSignature(SECRET, 'u/1/a.mp4', exp - 120, signLocal(SECRET, 'u/1/a.mp4', exp - 120))).toBe(false);
  });
});
