import { describe, expect, it } from 'vitest';
import { canRead, canSend, GrantError, parseGrants, parseGrantSpec } from '../src/grants.ts';
import { hashToken } from '../src/tokens.ts';
import { world } from './helpers.ts';

describe('grants', () => {
  it('parses specs into read and send rights', () => {
    expect(parseGrantSpec('peer:ops:rw')).toEqual({ channel: 'peer:ops', read: true, send: true });
    expect(parseGrantSpec('peer:ops:r')).toEqual({ channel: 'peer:ops', read: true, send: false });
    expect(parseGrantSpec('approval:deploys:w')).toEqual({ channel: 'approval:deploys', read: false, send: true });
  });

  it('accepts only peer and approval channels and refuses a bare *', () => {
    expect(() => parseGrantSpec('mail:inbox:rw')).toThrow(GrantError);
    expect(() => parseGrants([{ channel: '*', read: true, send: true }])).toThrow(GrantError);
    expect(() => parseGrantSpec('peer:Bad Name:rw')).toThrow(GrantError);
  });

  it('a kind wildcard reaches every name of that kind only', () => {
    const g = [parseGrantSpec('peer:*:r')];
    expect(canRead(g, 'peer:anything')).toBe(true);
    expect(canSend(g, 'peer:anything')).toBe(false);
    expect(canRead(g, 'approval:x')).toBe(false);
  });
});

describe('tokens', () => {
  it('stores only the hash and authenticates the bearer once created', () => {
    const w = world();
    const { token, info } = w.relay.tokens.create({ label: 'mac-1', owner: 'alice', grants: [parseGrantSpec('peer:team:rw')] });
    expect(token.startsWith('ar_')).toBe(true);
    const row = w.relay.db.prepare('SELECT hash FROM tokens WHERE id = ?').get(info.id) as { hash: string };
    expect(row.hash).toBe(hashToken(token));
    expect(JSON.stringify(w.relay.db.prepare('SELECT * FROM tokens').all())).not.toContain(token);
    expect(w.relay.tokens.authenticate(token)?.label).toBe('mac-1');
  });

  it('refuses a token without grants', () => {
    const w = world();
    expect(() => w.relay.tokens.create({ label: 'x', owner: 'alice', grants: [] })).toThrow(GrantError);
  });

  it('refuses unknown, short, revoked tokens and an unknown owner', () => {
    const w = world();
    const a = w.agent('mac-1', 'alice', 'peer:team:rw');
    expect(w.relay.tokens.authenticate('ar_short')).toBeUndefined();
    expect(w.relay.tokens.authenticate(undefined)).toBeUndefined();
    expect(w.relay.tokens.authenticate(`${a.token}x`)).toBeUndefined();
    w.relay.tokens.revoke('mac-1');
    expect(w.relay.tokens.authenticate(a.token)).toBeUndefined();
    expect(() => w.relay.tokens.create({ label: 'x', owner: 'nobody', grants: [parseGrantSpec('peer:team:r')] })).toThrow();
  });

  it('refuses a duplicate label and a bad time zone', () => {
    const w = world();
    w.agent('mac-1', 'alice', 'peer:team:r');
    expect(() => w.agent('mac-1', 'bob', 'peer:team:r')).toThrow();
    expect(() => w.relay.tokens.addOwner({ id: 'carol', name: 'Carol', tz: 'Mars/Base' })).toThrow();
  });
});
