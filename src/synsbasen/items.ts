import { SynsbasenHttpError } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';

/**
 * Synsbasen API calls. Keep these thin: build the path from validated input, call the client, return the response.
 * Every caller-supplied path segment goes through encodePathParam.
 */

/** Expansions of a vehicle that cost no tokens (`expand[]` on a vehicle lookup or search). */
export const FREE_EXPANSIONS = [
  'inspections',
  'equipment',
  'emission',
  'engine',
  'weight',
  'age',
  'axle',
  'body',
  'manufacturer',
  'driving_license',
  'periodic_taxes',
  'permits',
  'fuel_types',
  'supplementary_body_types',
  'leasing_periods',
  'appraisals_cached',
] as const;

export type FreeExpansion = (typeof FREE_EXPANSIONS)[number];

/** How a vehicle is named: by registration number, VIN or Synsbasen's own vehicle id. Exactly one. */
export interface VehicleRef {
  registration?: string;
  vin?: string;
  vehicleId?: string | number;
}

/** A registration number as Synsbasen takes it: no spaces, upper case (`AB 12 345` becomes `AB12345`). */
export function normaliseRegistration(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function exactlyOne(ref: VehicleRef): 'registration' | 'vin' | 'vehicleId' {
  const given = (['registration', 'vin', 'vehicleId'] as const).filter(key => ref[key] !== undefined && ref[key] !== '');
  if (given.length !== 1) {
    throw new Error('Give exactly one of registration, vin or vehicleId.');
  }
  return given[0]!;
}

/** The path of one vehicle: /vehicles/registration/{registration}, /vehicles/vin/{vin} or /vehicles/{vehicleId}. */
export function vehiclePath(ref: VehicleRef): string {
  switch (exactlyOne(ref)) {
    case 'registration':
      return `/vehicles/registration/${encodePathParam(normaliseRegistration(String(ref.registration)), 'registration')}`;
    case 'vin':
      return `/vehicles/vin/${encodePathParam(String(ref.vin).toUpperCase(), 'vin')}`;
    default:
      return `/vehicles/${encodePathParam(String(ref.vehicleId), 'vehicleId')}`;
  }
}

/** The query naming a vehicle for the live DMR lookup: `?registration=`, `?vin=` or `?id=`. */
function vehicleQuery(ref: VehicleRef): Record<string, string> {
  switch (exactlyOne(ref)) {
    case 'registration':
      return { registration: normaliseRegistration(String(ref.registration)) };
    case 'vin':
      return { vin: String(ref.vin).toUpperCase() };
    default:
      return { id: String(ref.vehicleId) };
  }
}

export async function getVehicle(
  client: UpstreamClient,
  input: VehicleRef & { expand?: readonly FreeExpansion[]; dmrFallback?: boolean },
): Promise<unknown> {
  return client.get(vehiclePath(input), {
    'expand[]': input.expand && input.expand.length > 0 ? [...new Set(input.expand)] : undefined,
    dmr_fallback: input.dmrFallback === true ? true : undefined,
  });
}

/** The live valuation (`expand[]=appraisals`): 1 token when Synsbasen has live access, else the stored one at 0. */
export async function getVehicleValuation(client: UpstreamClient, input: VehicleRef): Promise<unknown> {
  return client.get(vehiclePath(input), { 'expand[]': ['appraisals'] });
}

/** Live data from the Danish Motor Register (insurance, next inspection, leasing): 1 token. */
export async function getDmrData(client: UpstreamClient, input: VehicleRef): Promise<unknown> {
  return client.get('/vehicles/dmr_data', vehicleQuery(input));
}

/** Live data from the Danish Personal Property Register (liens and notices) by VIN: 1 token unless an own certificate. */
export async function getLiens(client: UpstreamClient, input: { vin: string }): Promise<unknown> {
  return client.get('/vehicles/tinglysning_data', { vin: input.vin.toUpperCase() });
}

export async function identifyFromImage(
  client: UpstreamClient,
  input: { imageUrl?: string; imageBase64?: string; expand?: readonly FreeExpansion[] },
): Promise<unknown> {
  const given = [input.imageUrl, input.imageBase64].filter(value => value !== undefined && value !== '');
  if (given.length !== 1) {
    throw new Error('Give exactly one of imageUrl or imageBase64.');
  }
  return client.search('/vehicles/by_image', {
    ...(input.imageUrl ? { image_url: input.imageUrl } : { image_base64: input.imageBase64 }),
    ...(input.expand && input.expand.length > 0 ? { expand: [...new Set(input.expand)] } : {}),
  });
}

/** The search input every search endpoint takes, in our names. */
export interface SearchInput {
  query?: Record<string, unknown>;
  method?: 'SELECT' | 'COUNT' | 'PERCENTAGE';
  select?: string | readonly string[];
  groupBy?: string | readonly string[];
  sorts?: readonly string[];
  percentageType?: string;
  page?: number;
  perPage?: number;
  expand?: readonly string[];
}

/** The body of a search, in Synsbasen's names; fields not given are left out. */
export function searchBody(input: SearchInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.query !== undefined) body.query = input.query;
  if (input.method !== undefined) body.method = input.method;
  if (input.select !== undefined) body.select = input.select;
  if (input.groupBy !== undefined) body.group_by = input.groupBy;
  if (input.sorts !== undefined) body.sorts = input.sorts;
  if (input.percentageType !== undefined) body.percentage_type = input.percentageType;
  if (input.page !== undefined) body.page = input.page;
  if (input.perPage !== undefined) body.per_page = input.perPage;
  if (input.expand !== undefined && input.expand.length > 0) body.expand = [...new Set(input.expand)];
  return body;
}

/** The resources with a search endpoint, as their path segment. */
export type SearchResource =
  | 'vehicles'
  | 'leasing_periods'
  | 'appraisals'
  | 'inspections'
  | 'test_centers'
  | 'brands'
  | 'models'
  | 'variants'
  | 'versions';

export async function search(client: UpstreamClient, resource: SearchResource, input: SearchInput): Promise<unknown> {
  return client.search(`/${resource}/search`, searchBody(input));
}

export async function getInspection(
  client: UpstreamClient,
  input: { inspectionId: string | number; includeVehicle?: boolean },
): Promise<unknown> {
  return client.get(`/inspections/${encodePathParam(String(input.inspectionId), 'inspectionId')}`, {
    'expand[]': input.includeVehicle === true ? ['vehicle'] : undefined,
  });
}

export async function listTestCenters(client: UpstreamClient): Promise<unknown> {
  return client.get('/test_centers');
}

export async function getTestCenter(client: UpstreamClient, input: { testCenterId: string | number }): Promise<unknown> {
  return client.get(`/test_centers/${encodePathParam(String(input.testCenterId), 'testCenterId')}`);
}

export async function listBrands(client: UpstreamClient): Promise<unknown> {
  return client.get('/brands');
}

/** The levels of the model catalogue, each with the level below it. */
export const CATALOG_LEVELS = {
  brand: { path: 'brands', children: 'models' },
  model: { path: 'models', children: 'variants' },
  variant: { path: 'variants', children: 'versions' },
  version: { path: 'versions', children: undefined },
} as const;

export type CatalogLevel = keyof typeof CATALOG_LEVELS;

export async function getCatalogEntry(
  client: UpstreamClient,
  input: { level: CatalogLevel; id: string | number; children?: boolean; page?: number; perPage?: number },
): Promise<unknown> {
  const level = CATALOG_LEVELS[input.level];
  const path = `/${level.path}/${encodePathParam(String(input.id), 'id')}`;
  if (input.children !== true) {
    return client.get(path);
  }
  if (level.children === undefined) {
    throw new Error('A version is the lowest level of the model catalogue; it has no entries below it.');
  }
  return client.get(`${path}/${level.children}`, { page: input.page, per_page: input.perPage });
}

export async function getBodyTypes(client: UpstreamClient, input: { bodyTypeId?: string | number }): Promise<unknown> {
  if (input.bodyTypeId === undefined || input.bodyTypeId === '') {
    return client.get('/body_types');
  }
  return client.get(`/body_types/${encodePathParam(String(input.bodyTypeId), 'bodyTypeId')}`);
}

/** Insurance of a dealer plate, looked up live: 1 token. */
export async function getDealerPlate(client: UpstreamClient, input: { registration: string }): Promise<unknown> {
  return client.get(`/dealer_plates/registration/${encodePathParam(normaliseRegistration(input.registration), 'registration')}`);
}

export async function getTokenBalance(client: UpstreamClient): Promise<unknown> {
  return client.get('/tokens');
}

/** Whether the key works: one call to the token balance. Only the outcome is returned, not the balance. */
export async function checkConnection(client: UpstreamClient): Promise<unknown> {
  await client.get('/tokens');
  return { connected: true };
}

export async function listWatchedVehicles(client: UpstreamClient, input: { page?: number; perPage?: number }): Promise<unknown> {
  return client.get('/watched_vehicles', { page: input.page, per_page: input.perPage });
}

/** Whether a vehicle is on the watch list: Synsbasen answers 200 when it is and 404 when it is not. */
export async function getWatchedVehicle(client: UpstreamClient, input: { vehicleId: string | number }): Promise<unknown> {
  const vehicleId = String(input.vehicleId);
  try {
    await client.get(`/watched_vehicles/${encodePathParam(vehicleId, 'vehicleId')}`);
    return { vehicleId, watched: true };
  } catch (error) {
    if (error instanceof SynsbasenHttpError && error.status === 404) {
      return { vehicleId, watched: false };
    }
    throw error;
  }
}

/** A vehicle id as Synsbasen's body takes it: a number when it is one within the safe range, else the text. */
function vehicleIdValue(value: string | number): string | number {
  const text = String(value);
  const number = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(number) ? number : text;
}

export async function watchVehicle(client: UpstreamClient, input: { vehicleId: string | number }): Promise<unknown> {
  const result = await client.post('/watched_vehicles', { vehicle_id: vehicleIdValue(input.vehicleId) });
  return result ?? { vehicleId: String(input.vehicleId), watched: true };
}

export async function unwatchVehicle(client: UpstreamClient, input: { vehicleId: string | number }): Promise<unknown> {
  const vehicleId = String(input.vehicleId);
  const result = await client.delete(`/watched_vehicles/${encodePathParam(vehicleId, 'vehicleId')}`);
  return result ?? { vehicleId, watched: false };
}
