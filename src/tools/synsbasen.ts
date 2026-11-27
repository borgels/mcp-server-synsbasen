import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WATCH_LIST_ANNOTATIONS,
  type WRITE_TOOL_ANNOTATIONS,
} from '../synsbasen/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../synsbasen/audit.js';
import { readOnlyClient, type UpstreamClient } from '../synsbasen/client.js';
import type { ActAs } from '../act-as.js';
import { formatUnknownError, nestedFailuresAsStatus, type SecretRedactor } from '../errors.js';
import {
  CATALOG_LEVELS,
  checkConnection,
  FREE_EXPANSIONS,
  getBodyTypes,
  getCatalogEntry,
  getDealerPlate,
  getDmrData,
  getInspection,
  getLiens,
  getTestCenter,
  getTokenBalance,
  getVehicle,
  getVehicleValuation,
  getWatchedVehicle,
  identifyFromImage,
  listBrands,
  listTestCenters,
  listWatchedVehicles,
  search,
  unwatchVehicle,
  watchVehicle,
} from '../synsbasen/items.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../synsbasen/policy.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS | typeof WATCH_LIST_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
}

/** A client that carries the redactor of its instance (SynsbasenClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`synsbasen_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  const run = definition.handler;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
    // Failures the API reports inside a successful body (`metadata.error`, `failures[]`, `errors[]`) become status-only
    // text. Synsbasen's own data has none of those names (an inspection's faults are `error_codes`).
    handler: async (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => nestedFailuresAsStatus(await run(client, input)),
  } as unknown as ToolDefinition;
}

/**
 * A Synsbasen id (vehicle, inspection, test centre, catalogue entry): a whole number, or the same as text. Text goes
 * into a path only through encodePathParam, which refuses anything that is not a single path segment.
 */
const idSchema = z.union([z.number().int().min(0), z.string().trim().min(1).max(64)]);

/** A Danish registration number, spaces allowed (`AB 12 345`); sent without spaces, in upper case. */
const registrationSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9 ]{1,10}$/)
  .describe('Registration number (number plate), e.g. AB12345. Spaces are removed.');
/** A vehicle identification number (VIN), up to 17 letters and digits. */
const vinSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,17}$/)
  .describe('Vehicle identification number (VIN), up to 17 characters.');

const vehicleRefShape = {
  registration: registrationSchema.optional(),
  vin: vinSchema.optional(),
  vehicleId: idSchema.optional().describe("Synsbasen's own vehicle id (from an earlier lookup or search)."),
};
const VEHICLE_REF_NOTE = 'Name the vehicle with exactly one of registration, vin or vehicleId.';

const expandSchema = z
  .array(z.enum(FREE_EXPANSIONS))
  .max(FREE_EXPANSIONS.length)
  .describe(
    'Extra data to include, none of which costs tokens: inspections, equipment, emission, engine, weight, age, axle, ' +
      'body, manufacturer, driving_license, periodic_taxes, permits, fuel_types, supplementary_body_types, ' +
      'leasing_periods, appraisals_cached (stored valuations).',
  );

const ATTRIBUTE = /^[a-z][a-z0-9_.]{0,99}$/;
/** An attribute or an aggregate expression over attributes, as Synsbasen documents them: `AVG(mileage)`, `YEAR(first_registration_date)`. */
const EXPRESSION = /^[A-Za-z][A-Za-z0-9_.(), *]{0,199}$/;
const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const searchShape = {
  query: z
    .record(z.string().regex(ATTRIBUTE), z.union([scalar, z.array(z.union([z.string().max(500), z.number(), z.null()])).max(200)]))
    .optional()
    .describe(
      'Filters: an attribute name joined with a predicate, e.g. {"brand_eq":"Volvo","model_year_gteq":2020}. ' +
        'Predicates: _eq, _not_eq, _start, _end, _cont, _i_cont, _matches, _in, _not_in, _lt, _lteq, _gt, _gteq, ' +
        '_between (a [from, to] pair; null leaves an end open), _null, _not_null, _true, _false (and _or_null variants).',
    ),
  method: z.enum(['SELECT', 'COUNT', 'PERCENTAGE']).optional().describe('SELECT (default) returns rows; COUNT and PERCENTAGE aggregate.'),
  select: z
    .union([z.string().regex(EXPRESSION), z.array(z.string().regex(EXPRESSION)).max(100)])
    .optional()
    .describe('Attributes or aggregate expressions to return, e.g. ["brand", "AVG(mileage)"].'),
  groupBy: z
    .union([z.string().regex(EXPRESSION), z.array(z.string().regex(EXPRESSION)).max(10)])
    .optional()
    .describe('Attribute(s) or expressions to group by, e.g. "YEAR(first_registration_date)".'),
  sorts: z.array(z.string().max(100)).max(10).optional().describe('Sort order, e.g. ["first_registration_date DESC"] or ["random"].'),
  percentageType: z.string().trim().max(50).optional().describe('How PERCENTAGE is computed, as Synsbasen documents it.'),
  page: z.number().int().min(1).max(100_000).optional().describe('Page, from 1.'),
  perPage: z.number().int().min(1).max(100).optional().describe('Rows per page, 1-100 (default 25).'),
};
const SEARCH_NOTE = 'Pages: continue while has_more is true. Counts toward the monthly request quota.';

const pageShape = {
  page: z.number().int().min(1).max(100_000).optional().describe('Page, from 1.'),
  perPage: z.number().int().min(1).max(100).optional().describe('Rows per page, 1-100 (default 25).'),
};

const vehicleExpandForSearch = z.array(z.enum(['vehicle'])).max(1).optional().describe('["vehicle"] to include the vehicle.');

/** The search paths of the catalogue levels, one per level. */
const CATALOG_SEARCH_PATHS = ['/brands/search', '/models/search', '/variants/search', '/versions/search'] as const;

const READ = 'read' as const;

export const SYNSBASEN_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'synsbasen_search_capabilities',
    title: 'Search Capabilities (Synsbasen)',
    description: 'Find the Synsbasen tools that fit a question, by words in their names and descriptions. Calls nothing at Synsbasen.',
    inputShape: {
      query: z.string().trim().max(200).optional().describe('Words to look for, e.g. "insurance" or "inspection".'),
      limit: z.number().int().min(1).max(50).optional().describe('Most tools to list (default 20).'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Synsbasen tools that fit.',
    upstream: [],
    handler: async (_client, input) => searchCapabilities(input),
  }),
  defineTool({
    name: 'synsbasen_check_connection',
    title: 'Check Connection (Synsbasen)',
    description: 'Check that the API key works, with one request to the token balance. Costs no tokens.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Synsbasen accepted the key.',
    upstream: [{ access: READ, method: 'GET', path: '/tokens' }],
    handler: async client => checkConnection(client),
  }),
  defineTool({
    name: 'synsbasen_get_token_balance',
    title: 'Get Token Balance (Synsbasen)',
    description:
      'The tokens left this period. Tokens pay for live lookups (Motor Register data, liens, valuations, dealer plates, ' +
      'image recognition) and do not roll over.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Token balance.',
    upstream: [{ access: READ, method: 'GET', path: '/tokens' }],
    handler: async client => getTokenBalance(client),
  }),
  defineTool({
    name: 'synsbasen_get_vehicle',
    title: 'Get Vehicle (Synsbasen)',
    description:
      'Look up one vehicle: make, model, variant, fuel, first registration, status, mileage, last and next inspection, ' +
      `leasing period, and optional extra data. ${VEHICLE_REF_NOTE} Costs no tokens. When a registration number has ` +
      'been on several vehicles, the most recent is returned.',
    inputShape: {
      ...vehicleRefShape,
      expand: expandSchema.optional(),
      dmrFallback: z
        .boolean()
        .optional()
        .describe('Ask the Motor Register live when Synsbasen does not have the vehicle yet (new or re-plated). Slower.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicle.',
    upstream: [
      { access: READ, method: 'GET', path: '/vehicles/registration/{registration}' },
      { access: READ, method: 'GET', path: '/vehicles/vin/{vin}' },
      { access: READ, method: 'GET', path: '/vehicles/{vehicleId}' },
    ],
    handler: async (client, input) => getVehicle(client, input),
  }),
  defineTool({
    name: 'synsbasen_search_vehicles',
    title: 'Search Vehicles (Synsbasen)',
    description:
      'Search the vehicles in the Danish Motor Register by their attributes (make, model, fuel, year, status, ...), or ' +
      `count them grouped by an attribute. ${SEARCH_NOTE}`,
    inputShape: { ...searchShape, expand: expandSchema.optional() },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicles found.',
    upstream: [{ access: READ, method: 'POST', path: '/vehicles/search' }],
    handler: async (client, input) => search(client, 'vehicles', input),
  }),
  defineTool({
    name: 'synsbasen_get_vehicle_dmr_data',
    title: 'Get Live Motor Register Data (Synsbasen)',
    description:
      'Live from the Danish Motor Register: insurance company and status with history, next inspection date, inspection ' +
      `notices, leasing period, Euro norm, battery and range. ${VEHICLE_REF_NOTE} Costs 1 token and takes a few seconds.`,
    inputShape: vehicleRefShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Live Motor Register data.',
    upstream: [{ access: READ, method: 'GET', path: '/vehicles/dmr_data' }],
    handler: async (client, input) => getDmrData(client, input),
  }),
  defineTool({
    name: 'synsbasen_get_vehicle_liens',
    title: 'Get Liens and Notices (Synsbasen)',
    description:
      'Live from the Danish Personal Property Register (Bilbogen) by VIN: registered liens and debt with creditors, ' +
      'debtors and amounts, and notices. Creditors and debtors can be private persons (name and birth date): personal ' +
      'data. Costs 1 token unless the account uses its own certificate.',
    inputShape: { vin: vinSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Liens and notices.',
    upstream: [{ access: READ, method: 'GET', path: '/vehicles/tinglysning_data' }],
    handler: async (client, input) => getLiens(client, input),
  }),
  defineTool({
    name: 'synsbasen_get_vehicle_valuation',
    title: 'Get Vehicle Valuation (Synsbasen)',
    description:
      `The vehicle with its current valuations from the tax authority's valuation service. ${VEHICLE_REF_NOTE} ` +
      'Costs 1 token when Synsbasen can ask live (also when no valuation is found); otherwise the stored valuations at no cost.',
    inputShape: vehicleRefShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicle with valuations.',
    upstream: [
      { access: READ, method: 'GET', path: '/vehicles/registration/{registration}' },
      { access: READ, method: 'GET', path: '/vehicles/vin/{vin}' },
      { access: READ, method: 'GET', path: '/vehicles/{vehicleId}' },
    ],
    handler: async (client, input) => getVehicleValuation(client, input),
  }),
  defineTool({
    name: 'synsbasen_identify_vehicle_from_image',
    title: 'Identify Vehicle from Image (Synsbasen)',
    description:
      'Read the number plate in a photo and look the vehicle up. Give exactly one of imageUrl (a public https address) ' +
      'or imageBase64 (JPEG, PNG or WebP, at most 10 MB). Costs 1 token and takes a few seconds.',
    inputShape: {
      imageUrl: z.url({ protocol: /^https?$/ }).max(2000).optional().describe('Public address of the image.'),
      imageBase64: z.string().max(14_000_000).optional().describe('The image as base64 or a data URL.'),
      expand: expandSchema.optional(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicle from the image.',
    upstream: [{ access: READ, method: 'POST', path: '/vehicles/by_image' }],
    handler: async (client, input) => identifyFromImage(client, input),
  }),
  defineTool({
    name: 'synsbasen_search_leasing_periods',
    title: 'Search Leasing Periods (Synsbasen)',
    description: `Search leasing periods (vehicle_id, leasing_period_start, leasing_period_end), newest first. ${SEARCH_NOTE}`,
    inputShape: searchShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Leasing periods.',
    upstream: [{ access: READ, method: 'POST', path: '/leasing_periods/search' }],
    handler: async (client, input) => search(client, 'leasing_periods', input),
  }),
  defineTool({
    name: 'synsbasen_search_appraisals',
    title: 'Search Valuations (Synsbasen)',
    description: `Search the stored valuations, e.g. by vehicle_id. Costs no tokens. ${SEARCH_NOTE}`,
    inputShape: { ...searchShape, expand: vehicleExpandForSearch },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Valuations.',
    upstream: [{ access: READ, method: 'POST', path: '/appraisals/search' }],
    handler: async (client, input) => search(client, 'appraisals', input),
  }),
  defineTool({
    name: 'synsbasen_get_inspection',
    title: 'Get Inspection (Synsbasen)',
    description: 'One inspection: date, kind, result, mileage, faults found, test centre and a link to the report.',
    inputShape: {
      inspectionId: idSchema.describe('Inspection id.'),
      includeVehicle: z.boolean().optional().describe('Also include the vehicle.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Inspection.',
    upstream: [{ access: READ, method: 'GET', path: '/inspections/{inspectionId}' }],
    handler: async (client, input) => getInspection(client, input),
  }),
  defineTool({
    name: 'synsbasen_search_inspections',
    title: 'Search Inspections (Synsbasen)',
    description: `Search inspections, e.g. all inspections of one vehicle_id or at one test_center_id. ${SEARCH_NOTE}`,
    inputShape: { ...searchShape, expand: vehicleExpandForSearch },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Inspections.',
    upstream: [{ access: READ, method: 'POST', path: '/inspections/search' }],
    handler: async (client, input) => search(client, 'inspections', input),
  }),
  defineTool({
    name: 'synsbasen_list_test_centers',
    title: 'List Test Centres (Synsbasen)',
    description: 'All active test centres: name, address, phone, website and company number.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Test centres.',
    upstream: [{ access: READ, method: 'GET', path: '/test_centers' }],
    handler: async client => listTestCenters(client),
  }),
  defineTool({
    name: 'synsbasen_get_test_center',
    title: 'Get Test Centre (Synsbasen)',
    description: 'One test centre by id.',
    inputShape: { testCenterId: idSchema.describe('Test centre id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Test centre.',
    upstream: [{ access: READ, method: 'GET', path: '/test_centers/{testCenterId}' }],
    handler: async (client, input) => getTestCenter(client, input),
  }),
  defineTool({
    name: 'synsbasen_search_test_centers',
    title: 'Search Test Centres (Synsbasen)',
    description: `Search test centres, inactive ones included, e.g. by zip code or city. ${SEARCH_NOTE}`,
    inputShape: searchShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Test centres.',
    upstream: [{ access: READ, method: 'POST', path: '/test_centers/search' }],
    handler: async (client, input) => search(client, 'test_centers', input),
  }),
  defineTool({
    name: 'synsbasen_list_brands',
    title: 'List Brands (Synsbasen)',
    description: 'All vehicle brands (make) in the model catalogue, with their ids.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Brands.',
    upstream: [{ access: READ, method: 'GET', path: '/brands' }],
    handler: async client => listBrands(client),
  }),
  defineTool({
    name: 'synsbasen_get_catalog_entry',
    title: 'Get Model Catalogue Entry (Synsbasen)',
    description:
      'One entry of the model catalogue (brand > model > variant > version) by id, or with children=true the entries one ' +
      "level below it (a brand's models, a model's variants, a variant's versions).",
    inputShape: {
      level: z.enum(['brand', 'model', 'variant', 'version']).describe('The level of the id.'),
      id: idSchema.describe('Id of the brand, model, variant or version.'),
      children: z.boolean().optional().describe('List the entries one level below instead.'),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Model catalogue entry.',
    upstream: [
      { access: READ, method: 'GET', path: '/brands/{id}' },
      { access: READ, method: 'GET', path: '/brands/{id}/models' },
      { access: READ, method: 'GET', path: '/models/{id}' },
      { access: READ, method: 'GET', path: '/models/{id}/variants' },
      { access: READ, method: 'GET', path: '/variants/{id}' },
      { access: READ, method: 'GET', path: '/variants/{id}/versions' },
      { access: READ, method: 'GET', path: '/versions/{id}' },
    ],
    handler: async (client, input) => getCatalogEntry(client, input),
  }),
  defineTool({
    name: 'synsbasen_search_catalog',
    title: 'Search Model Catalogue (Synsbasen)',
    description: `Search one level of the model catalogue (brand, model, variant or version), e.g. by name. ${SEARCH_NOTE}`,
    inputShape: { level: z.enum(['brand', 'model', 'variant', 'version']).describe('The level to search.'), ...searchShape },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Model catalogue entries.',
    upstream: CATALOG_SEARCH_PATHS.map(path => ({ access: READ, method: 'POST' as const, path })),
    handler: async (client, { level, ...rest }) => search(client, CATALOG_LEVELS[level].path, rest),
  }),
  defineTool({
    name: 'synsbasen_get_body_types',
    title: 'Get Body Types (Synsbasen)',
    description: 'The body types (sedan, station wagon, van, ...), or one by id.',
    inputShape: { bodyTypeId: idSchema.optional().describe('One body type; leave out for all.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Body types.',
    upstream: [
      { access: READ, method: 'GET', path: '/body_types' },
      { access: READ, method: 'GET', path: '/body_types/{bodyTypeId}' },
    ],
    handler: async (client, input) => getBodyTypes(client, input),
  }),
  defineTool({
    name: 'synsbasen_get_dealer_plate',
    title: 'Get Dealer Plate Insurance (Synsbasen)',
    description:
      'Insurance of a dealer plate, looked up live: insurance company, status, policy number and date. ' +
      'Costs 1 token and takes a few seconds.',
    inputShape: { registration: registrationSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Dealer plate insurance.',
    upstream: [{ access: READ, method: 'GET', path: '/dealer_plates/registration/{registration}' }],
    handler: async (client, input) => getDealerPlate(client, input),
  }),
  defineTool({
    name: 'synsbasen_list_watched_vehicles',
    title: 'List Watched Vehicles (Synsbasen)',
    description: "The vehicles on the account's watch list. Changes to them are sent to the account's own webhooks.",
    inputShape: pageShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Watched vehicles.',
    upstream: [{ access: READ, method: 'GET', path: '/watched_vehicles' }],
    handler: async (client, input) => listWatchedVehicles(client, input),
  }),
  defineTool({
    name: 'synsbasen_get_watched_vehicle',
    title: 'Is Vehicle Watched (Synsbasen)',
    description: 'Whether one vehicle (by vehicleId) is on the watch list.',
    inputShape: { vehicleId: idSchema.describe("Synsbasen's vehicle id.") },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Watch list status.',
    upstream: [{ access: READ, method: 'GET', path: '/watched_vehicles/{vehicleId}' }],
    handler: async (client, input) => getWatchedVehicle(client, input),
  }),
  defineTool({
    name: 'synsbasen_watch_vehicle',
    title: 'Watch Vehicle (Synsbasen)',
    description:
      "Put a vehicle (by vehicleId) on the account's watch list, so its changes are sent to the account's webhooks. " +
      'Free; the list holds at most as many vehicles as the token allowance. Requires write access on this instance.',
    inputShape: { vehicleId: idSchema.describe("Synsbasen's vehicle id.") },
    annotations: WATCH_LIST_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicle is watched.',
    upstream: [{ access: 'write', method: 'POST', path: '/watched_vehicles' }],
    handler: async (client, input) => watchVehicle(client, input),
  }),
  defineTool({
    name: 'synsbasen_unwatch_vehicle',
    title: 'Stop Watching Vehicle (Synsbasen)',
    description: 'Take a vehicle (by vehicleId) off the watch list. Requires write access on this instance.',
    inputShape: { vehicleId: idSchema.describe("Synsbasen's vehicle id.") },
    annotations: WATCH_LIST_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Vehicle is no longer watched.',
    upstream: [{ access: 'write', method: 'DELETE', path: '/watched_vehicles/{vehicleId}' }],
    handler: async (client, input) => unwatchVehicle(client, input),
  }),
];

/** Lowercase words of a text, letters and digits only. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2);
}

/**
 * The tools whose name, title or description share a word with the query, best first; an empty query, or one that
 * nothing fits, lists every tool. Only this server's own texts are searched.
 */
function searchCapabilities(input: { query?: string; limit?: number }): unknown {
  const asked = words(input.query ?? '');
  const limit = input.limit ?? 20;
  const tools = SYNSBASEN_TOOLS.filter(tool => tool.name !== 'synsbasen_search_capabilities' && !isToolDisabled(tool.name));
  const scored = tools.map((tool, order) => {
    // A word in the name or title weighs more than one in the description.
    const named = words(`${tool.name.replace(/_/g, ' ')} ${tool.title}`);
    const described = words(tool.description);
    const fits = (own: string[], word: string) => own.some(o => o === word || (o.length >= 4 && word.startsWith(o)));
    const score = asked.reduce((sum, word) => sum + (fits(named, word) ? 2 : fits(described, word) ? 1 : 0), 0);
    return { tool, order, score };
  });
  const hits = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const listed = asked.length === 0 || hits.length === 0 ? scored : hits;
  return {
    query: input.query ?? '',
    ...(asked.length > 0 && hits.length === 0 ? { note: 'Nothing fitted; every tool is listed.' } : {}),
    tools: listed.slice(0, limit).map(({ tool }) => ({ name: tool.name, title: tool.title, description: tool.description })),
  };
}

export function findTool(name: string): ToolDefinition | undefined {
  return SYNSBASEN_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(SYNSBASEN_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (SYNSBASEN_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return SYNSBASEN_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          return mcpToolResult(tool, await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input)));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
        }
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
  /**
   * Gateway only: the person to act as, as the host verified them (src/act-as.ts). Never written to audit events.
   * Without it the call runs as the key's own user.
   */
  actAs?: ActAs;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
