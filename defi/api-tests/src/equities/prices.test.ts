import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityPriceHistoryResponse, EquityOhlcvResponse } from './types';
import { priceHistoryArraySchema, ohlcvArraySchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectValidNumber,
  expectNonNegativeNumber,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany, expectFresh } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

const TIMEFRAMES = ['1W', '1M', '6M', '1Y', '5Y', 'MAX'];

describe('Equities API - Price History', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityPriceHistoryResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityPriceHistoryResponse>(
      endpoints.EQUITIES.PRICE_HISTORY(company.ticker, 'MAX', company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with an array of [date, price]', () => {
      expectSuccessfulResponse(response);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, priceHistoryArraySchema, 'Equities Price History');
      expect(result.success).toBe(true);
    });

    it('should have valid [date, price] tuples', () => {
      response.data.slice(0, 20).forEach(([date, price]) => {
        expect(typeof date).toBe('string');
        expect(date.length).toBeGreaterThan(0);
        expectValidNumber(price);
        expectNonNegativeNumber(price);
      });
    });
  });

  describe('Data Validation', () => {
    it('should be ordered newest-first', () => {
      const dates = response.data.map(([date]) => new Date(date).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
      }
    });

    it('should not be stale (newest point within 5 days)', () => {
      expect(response.data.length).toBeGreaterThan(0);
      const [newestDate] = response.data[0];
      expectFresh(newestDate, 'Price History');
    });

    it('should accept every valid timeframe', async () => {
      for (const tf of TIMEFRAMES) {
        const res = await apiClient.get<EquityPriceHistoryResponse>(
          endpoints.EQUITIES.PRICE_HISTORY(company.ticker, tf, company.country)
        );
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data)).toBe(true);
      }
    }, 60000);

    it('should return fewer points for a short timeframe than MAX', async () => {
      const short = await apiClient.get<EquityPriceHistoryResponse>(
        endpoints.EQUITIES.PRICE_HISTORY(company.ticker, '1M', company.country)
      );
      expect(short.data.length).toBeLessThanOrEqual(response.data.length);
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/price-history');
      expect(res.status).toBe(400);
    });

    it('should return 400 for an invalid timeframe', async () => {
      const res = await apiClient.get(
        endpoints.EQUITIES.PRICE_HISTORY(company.ticker, 'INVALID', company.country)
      );
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.PRICE_HISTORY('ZZZZNONEXISTENT', 'MAX'));
      expect(res.status).toBe(404);
    });
  });
});

describe('Equities API - OHLCV', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityOhlcvResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityOhlcvResponse>(
      endpoints.EQUITIES.OHLCV(company.ticker, 'MAX', company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with OHLCV rows', () => {
      expectSuccessfulResponse(response);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, ohlcvArraySchema, 'Equities OHLCV');
      expect(result.success).toBe(true);
    });

    it('should have valid [ts, o, h, l, c, vol] rows', () => {
      response.data.slice(0, 20).forEach(([ts, open, high, low, close, vol]) => {
        expect(Number.isInteger(ts)).toBe(true);
        expect(ts).toBeGreaterThan(0);
        expectValidNumber(open);
        expectValidNumber(high);
        expectValidNumber(low);
        expectValidNumber(close);
        expectNonNegativeNumber(vol);
        // High is the max and low is the min of the bar.
        expect(high).toBeGreaterThanOrEqual(low);
        expect(high).toBeGreaterThanOrEqual(open);
        expect(high).toBeGreaterThanOrEqual(close);
        expect(low).toBeLessThanOrEqual(open);
        expect(low).toBeLessThanOrEqual(close);
      });
    });
  });

  describe('Data Validation', () => {
    it('should be ordered newest-first by timestamp', () => {
      const ts = response.data.map(([t]) => t);
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
      }
    });

    it('should not be stale (newest bar within 5 days)', () => {
      expect(response.data.length).toBeGreaterThan(0);
      const [newestTs] = response.data[0];
      expectFresh(newestTs, 'OHLCV');
    });

    it('should accept every valid timeframe', async () => {
      for (const tf of TIMEFRAMES) {
        const res = await apiClient.get<EquityOhlcvResponse>(
          endpoints.EQUITIES.OHLCV(company.ticker, tf, company.country)
        );
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data)).toBe(true);
      }
    }, 60000);
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/ohlcv');
      expect(res.status).toBe(400);
    });

    it('should return 400 for an invalid timeframe', async () => {
      const res = await apiClient.get(
        endpoints.EQUITIES.OHLCV(company.ticker, 'INVALID', company.country)
      );
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.OHLCV('ZZZZNONEXISTENT', 'MAX'));
      expect(res.status).toBe(404);
    });
  });
});
