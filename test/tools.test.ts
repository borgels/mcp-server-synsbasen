import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/synsbasen/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createSynsbasenGateway, synsbasenGatewayTools } from '../src/gateway.js';
import { SYNSBASEN_TOOLS, executeTool, validateStartupConfig } from '../src/tools/synsbasen.js';
import { BASE, auditLines, connect, gateway, makeClient, texts } from './helpers.js';

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

const center = { data: { id: 12, name: 'Prøvehallen Nord', zip_code: '8000' } };
const vehicle = { data: { id: 1001, registration: 'AB12345', vin: 'YV1ABCDE123456789', brand: 'Volvo' } };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(SYNSBASEN_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = SYNSBASEN_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs a read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/test_centers/12`]: { body: center } });
    const result = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: 12 } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(center);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: '12', other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: '..' } });
    expect(traversal.isError).toBe(true);
    expect(texts(traversal).join(' ')).toContain('Invalid testCenterId');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the watch list changes unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    for (const name of ['synsbasen_watch_vehicle', 'synsbasen_unwatch_vehicle']) {
      const result = await mcpClient.callTool({ name, arguments: { vehicleId: '1001' } });
      expect(result.isError).toBe(true);
      expect(texts(result).join(' ')).toContain('SYNSBASEN_ENABLE_WRITES');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('watches and unwatches a vehicle when writes are enabled, and audits it', async () => {
    process.env.SYNSBASEN_ENABLE_WRITES = 'true';
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({
      [`POST ${BASE}/watched_vehicles`]: { status: 201, body: { data: { vehicle_id: 1001 } } },
      [`DELETE ${BASE}/watched_vehicles/1001`]: { status: 200, raw: '' },
    });
    const watched = await mcpClient.callTool({ name: 'synsbasen_watch_vehicle', arguments: { vehicleId: '1001' } });
    expect(watched.isError).toBeFalsy();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ vehicle_id: 1001 });
    const unwatched = await mcpClient.callTool({ name: 'synsbasen_unwatch_vehicle', arguments: { vehicleId: 1001 } });
    expect(unwatched.isError).toBeFalsy();
    expect(JSON.parse(texts(unwatched)[0] ?? '')).toEqual({ vehicleId: '1001', watched: false });

    const lines = auditLines(process.env.SYNSBASEN_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'start', 'finish']);
    expect(lines[0]?.target).toEqual({ vehicleId: '1001' });
  });

  it('hashes registration numbers and VINs in the audit log and keeps only the attribute names of a search', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/vehicles/registration/AB12345`]: { body: vehicle },
      [`POST ${BASE}/vehicles/search`]: { body: { data: [], has_more: false } },
    });
    await mcpClient.callTool({ name: 'synsbasen_get_vehicle', arguments: { registration: 'ab 12 345' } });
    await mcpClient.callTool({ name: 'synsbasen_search_vehicles', arguments: { query: { vin_eq: 'YV1ABCDE123456789' } } });
    const lines = auditLines(process.env.SYNSBASEN_AUDIT_LOG);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('AB12345');
    expect(text).not.toContain('ab 12 345');
    expect(text).not.toContain('YV1ABCDE');
    expect((lines[0]?.target as Record<string, unknown>).registrationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((lines[2]?.target as Record<string, unknown>).queryFields).toEqual(['vin_eq']);
  });

  it('hashes an id field that is not a decimal id, so a plate in the wrong field never lands in the log', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect();
    await mcpClient.callTool({ name: 'synsbasen_get_vehicle', arguments: { vehicleId: 'AB12345' } });
    await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: 'YV1ABCDE123456789' } });
    await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: 12 } });
    const lines = auditLines(process.env.SYNSBASEN_AUDIT_LOG);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('AB12345');
    expect(text).not.toContain('YV1ABCDE');
    expect((lines[0]?.target as Record<string, unknown>).vehicleIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines.at(-1)?.target).toEqual({ testCenterId: 12 });
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('SYNSBASEN_AUDIT_LOG');
    expect(() => createSynsbasenGateway({ apiKey: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('SYNSBASEN_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/test_centers/12`]: { body: center } });
    const result = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: '12' } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.SYNSBASEN_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/watched_vehicles`]: { body: {} } });
    // The log becomes unwritable after startup.
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'synsbasen_watch_vehicle', arguments: { vehicleId: '1001' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.SYNSBASEN_DISABLED_TOOLS = 'watch_vehicle,synsbasen_unwatch_vehicle';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('synsbasen_watch_vehicle');
    expect(tools.map(t => t.name)).not.toContain('synsbasen_unwatch_vehicle');
    expect(tools).toHaveLength(SYNSBASEN_TOOLS.length - 2);

    process.env.SYNSBASEN_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { apiKey: 'k' } })).toThrow('SYNSBASEN_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/test_centers/12`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: '12' } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.SYNSBASEN_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('Synsbasen requests', () => {
  function urlOf(fetchImpl: ReturnType<typeof gateway>['fetchImpl'], index = 0): URL {
    return new URL(String(fetchImpl.mock.calls[index]?.[0]));
  }

  it('looks a vehicle up by registration, VIN or id, with free expansions and the live fallback', async () => {
    const { gw, fetchImpl } = gateway({
      [`GET ${BASE}/vehicles/registration/AB12345`]: { body: vehicle },
      [`GET ${BASE}/vehicles/vin/YV1ABCDE123456789`]: { body: vehicle },
      [`GET ${BASE}/vehicles/1001`]: { body: vehicle },
    });
    const byPlate = await gw.callTool('get_vehicle', {
      registration: 'ab 12 345',
      expand: ['engine', 'inspections', 'engine'],
      dmrFallback: true,
    });
    expect(byPlate.structuredContent).toEqual(vehicle);
    expect(urlOf(fetchImpl).search).toBe('?expand%5B%5D=engine&expand%5B%5D=inspections&dmr_fallback=true');
    expect((await gw.callTool('get_vehicle', { vin: 'yv1abcde123456789' })).isError).toBeUndefined();
    expect((await gw.callTool('get_vehicle', { vehicleId: 1001 })).isError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses a vehicle named twice or not at all, and an expansion that costs tokens', async () => {
    const { gw, fetchImpl } = gateway();
    const twice = await gw.callTool('get_vehicle', { registration: 'AB12345', vin: 'YV1ABCDE123456789' });
    expect(twice.isError).toBe(true);
    expect(texts(twice).join(' ')).toContain('exactly one of registration, vin or vehicleId');
    expect((await gw.callTool('get_vehicle', {})).isError).toBe(true);
    expect((await gw.callTool('get_vehicle', { registration: 'AB12345', expand: ['dmr_data'] })).isError).toBe(true);
    expect((await gw.callTool('get_vehicle', { registration: 'AB/12345' })).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the live lookups to their own endpoints', async () => {
    const { gw, fetchImpl } = gateway({
      [`GET ${BASE}/vehicles/dmr_data`]: { body: { data: { insurance_company: 'Forsikring A/S' } } },
      [`GET ${BASE}/vehicles/tinglysning_data`]: { body: { data: { liabilities: [], notices: [] } } },
      [`GET ${BASE}/vehicles/registration/AB12345`]: { body: vehicle },
      [`GET ${BASE}/dealer_plates/registration/AB1234`]: { body: { data: { status: 'active' } } },
    });
    await gw.callTool('get_vehicle_dmr_data', { registration: 'AB12345' });
    expect(urlOf(fetchImpl, 0).search).toBe('?registration=AB12345');
    await gw.callTool('get_vehicle_liens', { vin: 'yv1abcde123456789' });
    expect(urlOf(fetchImpl, 1).search).toBe('?vin=YV1ABCDE123456789');
    await gw.callTool('get_vehicle_valuation', { registration: 'AB12345' });
    expect(urlOf(fetchImpl, 2).search).toBe('?expand%5B%5D=appraisals');
    expect((await gw.callTool('get_dealer_plate', { registration: 'AB 1234' })).isError).toBeUndefined();
  });

  it('sends a search body in Synsbasen names', async () => {
    const { gw, fetchImpl } = gateway({ [`POST ${BASE}/models/search`]: { body: { data: [], has_more: false } } });
    const result = await gw.callTool('search_catalog', {
      level: 'model',
      query: { name_i_cont: 'v60', brand_id_in: [1, 2] },
      method: 'COUNT',
      groupBy: 'brand_id',
      perPage: 10,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      query: { name_i_cont: 'v60', brand_id_in: [1, 2] },
      method: 'COUNT',
      group_by: 'brand_id',
      per_page: 10,
    });
    expect((await gw.callTool('search_vehicles', { query: { 'Bad Name': 1 } })).isError).toBe(true);
  });

  it('takes aggregate expressions and open-ended ranges in a search', async () => {
    const { gw, fetchImpl } = gateway({ [`POST ${BASE}/vehicles/search`]: { body: { data: [] } } });
    const result = await gw.callTool('search_vehicles', {
      query: { mileage_between: [null, 100000], model_year_between: [2018, null] },
      method: 'COUNT',
      select: ['brand', 'AVG(mileage)'],
      groupBy: 'YEAR(first_registration_date)',
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      query: { mileage_between: [null, 100000], model_year_between: [2018, null] },
      method: 'COUNT',
      select: ['brand', 'AVG(mileage)'],
      group_by: 'YEAR(first_registration_date)',
    });
    expect((await gw.callTool('search_vehicles', { select: ['brand; DROP'] })).isError).toBe(true);
  });

  it('identifies a vehicle from an image address or base64, never both', async () => {
    const { gw, fetchImpl } = gateway({ [`POST ${BASE}/vehicles/by_image`]: { body: vehicle } });
    const ok = await gw.callTool('identify_vehicle_from_image', { imageUrl: 'https://images.vendor.test/a.jpg' });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ image_url: 'https://images.vendor.test/a.jpg' });
    const both = await gw.callTool('identify_vehicle_from_image', {
      imageUrl: 'https://images.vendor.test/a.jpg',
      imageBase64: 'AAAA',
    });
    expect(both.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers whether a vehicle is watched from 200 and 404', async () => {
    const { gw } = gateway({ [`GET ${BASE}/watched_vehicles/1001`]: { body: {} } });
    expect((await gw.callTool('get_watched_vehicle', { vehicleId: '1001' })).structuredContent).toEqual({
      vehicleId: '1001',
      watched: true,
    });
    expect((await gw.callTool('get_watched_vehicle', { vehicleId: '1002' })).structuredContent).toEqual({
      vehicleId: '1002',
      watched: false,
    });
  });

  it('lists the children of a catalogue entry and refuses them below a version', async () => {
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/brands/7/models`]: { body: { data: [] } } });
    expect((await gw.callTool('get_catalog_entry', { level: 'brand', id: '7', children: true, page: 2 })).isError).toBeUndefined();
    expect(urlOf(fetchImpl).search).toBe('?page=2');
    const below = await gw.callTool('get_catalog_entry', { level: 'version', id: '7', children: true });
    expect(below.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('checks the connection without passing the balance on, and searches its own tools without calling Synsbasen', async () => {
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/tokens`]: { body: { data: { tokens: 1337 } } } });
    expect((await gw.callTool('check_connection', {})).structuredContent).toEqual({ connected: true });
    expect((await gw.callTool('get_token_balance', {})).structuredContent).toEqual({ data: { tokens: 1337 } });
    const found = await gw.callTool('search_capabilities', { query: 'liens' });
    expect((found.structuredContent as { tools: Array<{ name: string }> }).tools[0]?.name).toBe('synsbasen_get_vehicle_liens');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests other than a search', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const tool = SYNSBASEN_TOOLS.find(t => t.name === 'synsbasen_get_test_center')!;
    const misbehaving = [
      async (c: UpstreamClient) => c.post('/watched_vehicles', { vehicle_id: 1 }),
      async (c: UpstreamClient) => c.delete('/watched_vehicles/1'),
    ];
    for (const handler of misbehaving) {
      await expect(executeTool({ ...tool, handler }, client, { testCenterId: '1' })).rejects.toThrow(/Read-only tool .* (POST|DELETE)/);
    }
    const searchElsewhere = async (c: UpstreamClient) => c.search('/watched_vehicles', {});
    await expect(executeTool({ ...tool, handler: searchElsewhere }, client, { testCenterId: '1' })).rejects.toThrow('Refused');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = SYNSBASEN_TOOLS.find(t => t.name === 'synsbasen_get_test_center')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header Authorization: Bearer other-secret, {"apiKey":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'synsbasen_get_test_center', arguments: { testCenterId: '1' } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix, reads, watching as a write and unwatching as destructive, with valid JSON Schemas', () => {
    const risks = Object.fromEntries(synsbasenGatewayTools.map(t => [t.name, [t.riskLevel, t.enabledByDefault]]));
    expect(risks.watch_vehicle).toEqual(['write', false]);
    expect(risks.unwatch_vehicle).toEqual(['destructive', false]);
    const unwatch = SYNSBASEN_TOOLS.find(t => t.name === 'synsbasen_unwatch_vehicle')!;
    expect(unwatch.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const notRead = Object.entries(risks)
      .filter(([, [risk]]) => risk !== 'read')
      .map(([name]) => name)
      .sort();
    expect(notRead).toEqual(['unwatch_vehicle', 'watch_vehicle']);
    const ajv = new Ajv({ strict: true });
    for (const tool of synsbasenGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.SYNSBASEN_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/test_centers/12`]: { body: center } });

    const ok = await gw.callTool('get_test_center', { testCenterId: '12' }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(center);

    const invalid = await gw.callTool('get_test_center', { testCenterId: '12', extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('watch_vehicle', { vehicleId: '1001' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.SYNSBASEN_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: 'user@vendor.test', action: 'start' });
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
