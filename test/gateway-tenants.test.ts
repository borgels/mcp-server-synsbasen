import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, SynsbasenClient } from '../src/synsbasen/client.js';
import { createSynsbasenGateway, synsbasenGatewayTools, synsbasenToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { SYNSBASEN_TOOLS } from '../src/tools/synsbasen.js';
import { BASE, auditLines, connect, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'synsbasen-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('SYNSBASEN_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'alpha-0123456789-kq';
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires apiKey, defaults baseUrl to Synsbasen and ignores the environment', () => {
    process.env.SYNSBASEN_API_KEY = ENV_KEY;
    process.env.SYNSBASEN_BASE_URL = BASE;

    expect(() => createSynsbasenGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);
    expect(() => createSynsbasenGateway({ apiKey: KEY_A })).not.toThrow();
    expect(() => createSynsbasenGateway({ apiKey: KEY_A, baseUrl: '  ' })).toThrow(/requires options\.baseUrl/);
    expect(() => createSynsbasenGateway({ apiKey: '  ', baseUrl: BASE })).toThrow(/requires options\.apiKey/);
    expect(() => createSynsbasenGateway(undefined as never)).toThrow(/requires options\.apiKey/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, SYNSBASEN_API_KEY: ENV_KEY, SYNSBASEN_BASE_URL: BASE };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createSynsbasenGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.apiKey/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/test_centers/i1`]: { body: { id: 'i1' } } });
    const gw = createSynsbasenGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_test_center', { testCenterId: 'i1' });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(`Bearer ${KEY_A}`);

    expect(reads.has('SYNSBASEN_API_KEY')).toBe(false);
    expect(reads.has('SYNSBASEN_BASE_URL')).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.SYNSBASEN_API_KEY = ENV_KEY;
    process.env.SYNSBASEN_BASE_URL = BASE;
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new SynsbasenClient({ fetchImpl }).get('/test_centers/1');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[API_KEY_HEADER]).toBe(`Bearer ${ENV_KEY}`);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createSynsbasenGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: echoingFetch(KEY_A) });
    const b = createSynsbasenGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_test_center', { testCenterId: 'i1' })).join(' ');
    const resultB = texts(await b.callTool('get_test_center', { testCenterId: 'i1' })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new SynsbasenClient({ apiKey: KEY_A, baseUrl: BASE, credentialEnv: {} });
    const b = new SynsbasenClient({ apiKey: KEY_B, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createSynsbasenGateway({ apiKey: `short-lived-key-${index}`, baseUrl: BASE });
    }
    const fresh = new SynsbasenClient({ apiKey: KEY_A, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createSynsbasenGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = createSynsbasenGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_test_center', { testCenterId: 'i1' }, { requestId: 'a' });
    await b.callTool('get_test_center', { testCenterId: 'i1' }, { requestId: 'b' });

    const errors = auditLines(process.env.SYNSBASEN_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual(['a', 'b']);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = SYNSBASEN_TOOLS.find(t => t.name === 'synsbasen_get_test_center')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: 'i1' } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createSynsbasenGateway> | undefined = createSynsbasenGateway({
      apiKey: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  search_capabilities: { query: 'inspection' },
  check_connection: {},
  get_token_balance: {},
  get_vehicle: { registration: 'AB12345', expand: ['engine'] },
  search_vehicles: { query: { brand_eq: 'Volvo' }, perPage: 5 },
  get_vehicle_dmr_data: { vin: 'YV1ABCDE123456789' },
  get_vehicle_liens: { vin: 'YV1ABCDE123456789' },
  get_vehicle_valuation: { vehicleId: '1001' },
  identify_vehicle_from_image: { imageUrl: 'https://images.vendor.test/car.jpg' },
  search_leasing_periods: { query: { vehicle_id_eq: 1001 } },
  search_appraisals: { query: { vehicle_id_eq: 1001 } },
  get_inspection: { inspectionId: '77' },
  search_inspections: { query: { vehicle_id_eq: 1001 } },
  list_test_centers: {},
  get_test_center: { testCenterId: '12' },
  search_test_centers: { query: { zip_code_eq: '8000' } },
  list_brands: {},
  get_catalog_entry: { level: 'model', id: '5', children: true },
  search_catalog: { level: 'brand', query: { name_i_cont: 'vol' } },
  get_body_types: { bodyTypeId: '3' },
  get_dealer_plate: { registration: 'AB1234' },
  list_watched_vehicles: { page: 1 },
  get_watched_vehicle: { vehicleId: '1001' },
  watch_vehicle: { vehicleId: '1001' },
  unwatch_vehicle: { vehicleId: '1001' },
};

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(synsbasenToolCatalog.map(entry => entry.name)).toEqual(synsbasenGatewayTools.map(tool => tool.name));
    for (const entry of synsbasenToolCatalog) {
      const { upstream, broad, ...definition } = entry;
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(synsbasenGatewayTools.find(tool => tool.name === entry.name));
      // Only the capability search answers from the tool table without calling Synsbasen.
      expect(upstream.length > 0 || entry.name === 'search_capabilities').toBe(true);
      for (const operation of upstream) {
        // A reading POST is a search or the image recognition (UpstreamClient.search); every other read is a GET.
        const readingPost = /\/(?:search|by_image)$/.test(operation.path);
        expect(operation.access === 'read' ? operation.method === 'GET' || readingPost : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      synsbasenToolCatalog.map(entry => `synsbasen_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = synsbasenToolCatalog.find(e => `synsbasen_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(synsbasenToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(synsbasenToolCatalog);
    expect(() => {
      (synsbasenToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.SYNSBASEN_ENABLE_WRITES = 'true';
    for (const entry of synsbasenToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
      const gw = createSynsbasenGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await gw.callTool(entry.name, input as GatewayJsonObject);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input![name] ?? ''))),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname.slice(new URL(BASE).pathname.length),
      }));
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
