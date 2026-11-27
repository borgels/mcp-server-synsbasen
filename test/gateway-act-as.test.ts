// Act as a person (src/act-as.ts): the host's verified person reaches the handler through the call scope, a refusal
// comes back as `actAsRefused` with a fixed text, a malformed person refuses the call before anything is sent, and the
// email is never written to the audit or put in a result.
import { describe, expect, it, vi } from 'vitest';
import { ActAsRefusedError, normaliseActAs } from '../src/act-as.js';
import { currentActAs } from '../src/example/policy.js';
import { createExampleGateway } from '../src/gateway.js';
import { BASE } from './helpers.js';

const KEY = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';
const EMAIL = 'Mette.Hansen@Demobyg.example';

/** What create_item's handler throws instead of calling the API, as a server's handler does when it finds no user. */
const handler = vi.hoisted(() => ({ refuse: undefined as Error | undefined }));
vi.mock('../src/example/items.js', async original => {
  const actual = await original<typeof import('../src/example/items.js')>();
  return {
    ...actual,
    createItem: (...args: Parameters<typeof actual.createItem>) => {
      if (handler.refuse) return Promise.reject(handler.refuse);
      return actual.createItem(...args);
    },
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A gateway whose upstream records the person in scope at each request, and can refuse as a server would. */
function gateway(refuse?: ActAsRefusedError) {
  handler.refuse = refuse;
  const seen: Array<string | undefined> = [];
  const records: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async () => {
    seen.push(currentActAs()?.email);
    return json({ id: 'i1', name: 'n' });
  };
  const gw = createExampleGateway({
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl,
    maxAttempts: 1,
    policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
  });
  return { gw, seen, records };
}

describe('normaliseActAs', () => {
  it('takes a verified email, lowercased and trimmed, with an optional name', () => {
    expect(normaliseActAs(undefined)).toBeUndefined();
    expect(normaliseActAs({ email: `  ${EMAIL} ` })).toEqual({ email: EMAIL.toLowerCase() });
    expect(normaliseActAs({ email: EMAIL, name: ' Mette Hansen ' })).toEqual({ email: EMAIL.toLowerCase(), name: 'Mette Hansen' });
  });

  it('refuses anything that is not one', () => {
    for (const value of [{ email: 'a..b@example.test' }, { email: '.a@example.test' }, { email: 'a.@example.test' }, { email: `${'a'.repeat(65)}@example.test` }, null, 'x@y.dk', { email: 'no-at-sign' }, { email: 'a\u0000b@example.test' }, { email: 'a b@example.test' }, { email: EMAIL, name: null }, { email: 'a@b' }, { email: 7 }, { email: EMAIL, name: '' }, { email: EMAIL, name: 'a\nb' }, [EMAIL]]) {
      expect(() => normaliseActAs(value), JSON.stringify(value)).toThrow(ActAsRefusedError);
    }
  });
});

describe('a gateway call with actAs', () => {
  it('gives the handler the person through the call scope, and only for that call', async () => {
    const { gw, seen } = gateway();
    expect((await gw.callTool('create_item', { name: 'n' }, { caller: 'p1', actAs: { email: EMAIL } })).isError).toBeUndefined();
    expect((await gw.callTool('create_item', { name: 'n' }, { caller: 'p1' })).isError).toBeUndefined();
    expect(seen).toEqual([EMAIL.toLowerCase(), undefined]);
  });

  it('answers a refusal from the handler with actAsRefused and a fixed text, never the email', async () => {
    for (const refusal of ['no_user', 'not_permitted'] as const) {
      const { gw } = gateway(new ActAsRefusedError(refusal));
      const result = await gw.callTool('create_item', { name: 'n' }, { caller: 'p1', actAs: { email: EMAIL } });
      expect(result.isError).toBe(true);
      expect(result.actAsRefused).toBe(refusal);
      expect(JSON.stringify(result).toLowerCase()).not.toContain(EMAIL.toLowerCase());
    }
  });

  it('refuses a malformed person before anything is sent, null included', async () => {
    for (const actAs of [{ email: 'not an email' }, null, { email: 'a\u0000b@example.test' }]) {
      const { gw, seen } = gateway();
      const result = await gw.callTool('create_item', { name: 'n' }, { caller: 'p1', actAs: actAs as never });
      expect(result, JSON.stringify(actAs)).toMatchObject({ isError: true, actAsRefused: 'invalid' });
      expect(seen).toEqual([]);
    }
  });

  it('keeps the person of each call to that call when calls run at the same time', async () => {
    const { gw, seen } = gateway();
    await Promise.all([
      gw.callTool('create_item', { name: 'a' }, { actAs: { email: 'a@demobyg.example' } }),
      gw.callTool('create_item', { name: 'b' }, { actAs: { email: 'b@demobyg.example' } }),
      gw.callTool('create_item', { name: 'c' }),
    ]);
    expect([...seen].sort()).toEqual(['a@demobyg.example', 'b@demobyg.example', undefined].sort());
  });

  it('never writes the email to the audit', async () => {
    const { gw, records } = gateway();
    await gw.callTool('get_item', { itemId: 'i1' }, { caller: 'p1', actAs: { email: EMAIL } });
    await gw.callTool('create_item', { name: 'n' }, { caller: 'p1', actAs: { email: EMAIL } });
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records).toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('keeps actAsRefused only on an error result', async () => {
    const { gw } = gateway();
    const result = await gw.callTool('get_item', { itemId: 'i1' }, { actAs: { email: EMAIL } });
    expect(result.isError).toBeUndefined();
    expect('actAsRefused' in result).toBe(false);
  });
});

describe('the refusal of a malformed person', () => {
  it('passes the same sink check as every other result: no piece of the key leaves, field names included', async () => {
    // A key the first filter admits that shares a piece with the result's field name actAsRefused.
    const apiKey = 'Zq7pactAsRK9mWb4TnR8yLc3Hd';
    const gw = createExampleGateway({ apiKey, baseUrl: BASE, fetchImpl: async () => json({}), maxAttempts: 1, policy: { enableWrites: true } });
    const result = await gw.callTool('create_item', { name: 'n' }, { actAs: null as never });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    for (let i = 0; i + 6 <= apiKey.length; i += 1) expect(text, apiKey.slice(i, i + 6)).not.toContain(apiKey.slice(i, i + 6));
  });

  it('keeps dotted addresses that are valid', () => {
    expect(normaliseActAs({ email: 'mette.k.hansen@demobyg.example' })).toEqual({ email: 'mette.k.hansen@demobyg.example' });
  });
});
