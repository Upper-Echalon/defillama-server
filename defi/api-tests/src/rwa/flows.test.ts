import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { RwaCurrentResponse, RwaFlowsResponse } from './types';
import { rwaFlowsResponseSchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectObjectResponse,
  expectValidTimestamp,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';

const apiClient = createApiClient(endpoints.RWA.BASE_URL);

const ONE_DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * ONE_DAY;

describe('RWA API - Flows', () => {
  let currentResponse: ApiResponse<RwaCurrentResponse>;

  beforeAll(async () => {
    currentResponse = await apiClient.get<RwaCurrentResponse>(endpoints.RWA.CURRENT);
  });

  it('should expose CORS headers', () => {
    expectCorsHeaders(currentResponse);
  });

  it('should return flow series for a valid RWA ID with start param', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);
    const start = Math.floor(Date.now() / 1000) - THIRTY_DAYS;

    const response = await apiClient.get<RwaFlowsResponse>(
      `${endpoints.RWA.FLOWS(id)}?start=${start}`
    );
    expectSuccessfulResponse(response);
    expectObjectResponse(response);

    const result = validate(response.data, rwaFlowsResponseSchema, 'RWA Flows');
    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors (first 5):', result.errors.slice(0, 5));
    }

    expect(String(response.data.id)).toBe(id);
    expect(response.data.start).toBe(start);
    expect(response.data.end).toBeGreaterThanOrEqual(start);
    expect(Array.isArray(response.data.data)).toBe(true);

    if (response.data.data.length > 0) {
      response.data.data.slice(0, 5).forEach((point) => {
        expectValidTimestamp(point.timestamp);
      });
    }

    // Coverage is always reported (non-null flow days / total days in window).
    expect(typeof (response.data as any).coverage).toBe('number');
    expect((response.data as any).coverage).toBeGreaterThanOrEqual(0);
    expect((response.data as any).coverage).toBeLessThanOrEqual(1);
  });

  it('should join onChainMcap onto each point with withMcap=true', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);
    const start = Math.floor(Date.now() / 1000) - THIRTY_DAYS;

    const response = await apiClient.get<RwaFlowsResponse>(
      `${endpoints.RWA.FLOWS(id)}?start=${start}&withMcap=true`
    );
    expectSuccessfulResponse(response);
    expect(typeof (response.data as any).coverage).toBe('number');

    // Every point carries an `mcap` key: a number (level that day) or null (no
    // cached record) — never absent, so the FE can align flow vs price by date.
    response.data.data.slice(0, 5).forEach((point) => {
      const mcap = (point as any).mcap;
      expect(mcap === null || typeof mcap === 'number').toBe(true);
    });
  });

  it('should accept an explicit end query param', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);
    const end = Math.floor(Date.now() / 1000);
    const start = end - THIRTY_DAYS;

    const response = await apiClient.get<RwaFlowsResponse>(
      `${endpoints.RWA.FLOWS(id)}?start=${start}&end=${end}`
    );
    expectSuccessfulResponse(response);
    expect(response.data.start).toBe(start);
    expect(response.data.end).toBe(end);
  });

  it('should reject when start query param is missing', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);

    const response = await apiClient.get(endpoints.RWA.FLOWS(id));
    expect(response.status).toBe(400);
  });

  it('should reject when start is non-numeric', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);

    const response = await apiClient.get(`${endpoints.RWA.FLOWS(id)}?start=notanumber`);
    expect(response.status).toBe(400);
  });

  it('should reject when end is before start', async () => {
    const firstItem = currentResponse.data[0];
    const id = String(firstItem.id);
    const start = Math.floor(Date.now() / 1000);
    const end = start - ONE_DAY;

    const response = await apiClient.get(
      `${endpoints.RWA.FLOWS(id)}?start=${start}&end=${end}`
    );
    expect(response.status).toBe(400);
  });
});

describe('RWA API - Flows aggregates', () => {
  it('should serve the overview flow series', async () => {
    const response = await apiClient.get<any>(endpoints.RWA.FLOWS_OVERVIEW);
    // 404 only if the cron hasn't generated aggregates yet on this env.
    if (response.status === 404) return;
    expectSuccessfulResponse(response);
    expect(Array.isArray(response.data.series)).toBe(true);
    expect(typeof response.data.coverage).toBe('number');
  });

  it('should serve a stacked overview with splitBy=group', async () => {
    const response = await apiClient.get<any>(`${endpoints.RWA.FLOWS_OVERVIEW}?splitBy=group`);
    if (response.status === 404) return;
    expectSuccessfulResponse(response);
    expect(Array.isArray(response.data)).toBe(true);
  });

  it('should reject leaderboard with an invalid `by`', async () => {
    const response = await apiClient.get(`${endpoints.RWA.FLOWS_LEADERBOARD}?by=bogus&window=7d`);
    expect(response.status).toBe(400);
  });

  it('should reject leaderboard with an invalid `window`', async () => {
    const response = await apiClient.get(`${endpoints.RWA.FLOWS_LEADERBOARD}?by=asset&window=99d`);
    expect(response.status).toBe(400);
  });

  it('should return a ranked, limited leaderboard', async () => {
    const response = await apiClient.get<any>(`${endpoints.RWA.FLOWS_LEADERBOARD}?by=asset&window=30d&limit=5`);
    if (response.status === 404) return;
    expectSuccessfulResponse(response);
    expect(response.data.by).toBe('asset');
    expect(response.data.window).toBe('30d');
    expect(Array.isArray(response.data.rows)).toBe(true);
    expect(response.data.rows.length).toBeLessThanOrEqual(5);
    // Rows are ranked by |flow| descending.
    const mags = response.data.rows.map((r: any) => Math.abs(r.flow));
    for (let i = 1; i < mags.length; i++) {
      expect(mags[i - 1]).toBeGreaterThanOrEqual(mags[i]);
    }
  });
});
