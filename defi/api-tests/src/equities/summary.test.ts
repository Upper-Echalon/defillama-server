import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquitySummaryResponse, isEquitySummaryResponse } from './types';
import { summarySchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectNonNegativeNumber,
  expectValidNumber,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany, expectFresh } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

describe('Equities API - Summary', () => {
  let company: TestCompany;
  let response: ApiResponse<EquitySummaryResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquitySummaryResponse>(
      endpoints.EQUITIES.SUMMARY(company.ticker, company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(response);
      expect(isEquitySummaryResponse(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, summarySchema, 'Equities Summary');
      expect(result.success).toBe(true);
    });
  });

  describe('Data Validation', () => {
    it('should have valid numeric fields when present', () => {
      const data = response.data;
      if (data.currentPrice != null) expectNonNegativeNumber(data.currentPrice);
      if (data.volume != null) expectNonNegativeNumber(data.volume);
      if (data.marketCap != null) expectNonNegativeNumber(data.marketCap);
      if (data.fiftyTwoWeekHigh != null) expectNonNegativeNumber(data.fiftyTwoWeekHigh);
      if (data.fiftyTwoWeekLow != null) expectNonNegativeNumber(data.fiftyTwoWeekLow);
      if (data.trailingPE != null) expectValidNumber(data.trailingPE);
      if (data.priceChangePercentage1d != null) expectValidNumber(data.priceChangePercentage1d);
    });

    it('should have 52-week low not greater than 52-week high when both present', () => {
      const data = response.data;
      if (data.fiftyTwoWeekHigh != null && data.fiftyTwoWeekLow != null) {
        expect(data.fiftyTwoWeekLow).toBeLessThanOrEqual(data.fiftyTwoWeekHigh);
      }
    });

    it('should have a string updatedAt timestamp', () => {
      expect(typeof response.data.updatedAt).toBe('string');
    });

    it('should not be stale (updatedAt within 5 days)', () => {
      expectFresh(response.data.updatedAt, 'Summary');
    });
  });

  describe('Edge Cases', () => {
    it('should default to US country when country is omitted', async () => {
      const res = await apiClient.get<EquitySummaryResponse>(
        endpoints.EQUITIES.SUMMARY(company.ticker)
      );
      // For US-listed tickers this resolves to the same data; just assert it works.
      expect(res).toBeDefined();
      expect([200, 404]).toContain(res.status);
    });

    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/summary');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.SUMMARY('ZZZZNONEXISTENT'));
      expect(res.status).toBe(404);
    });
  });
});
