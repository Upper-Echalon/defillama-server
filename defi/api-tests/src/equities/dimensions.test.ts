import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityDimensionsResponse, isEquityDimensionsResponse } from './types';
import { dimensionsSchema } from './schemas';
import { expectSuccessfulResponse, expectValidNumber } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

const METRICS = ['revenue', 'holdersRevenue', 'earnings'] as const;
const PERIODS = ['annual', 'quarterly'] as const;

describe('Equities API - Dimensions', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityDimensionsResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityDimensionsResponse>(
      endpoints.EQUITIES.DIMENSIONS(company.ticker, company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(response);
      expect(isEquityDimensionsResponse(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, dimensionsSchema, 'Equities Dimensions');
      expect(result.success).toBe(true);
    });

    it('should have revenue, holdersRevenue, and earnings each with annual/quarterly', () => {
      METRICS.forEach((metric) => {
        expect(response.data).toHaveProperty(metric);
        PERIODS.forEach((period) => {
          expect(Array.isArray(response.data[metric][period])).toBe(true);
        });
      });
    });
  });

  describe('Data Validation', () => {
    it('should have valid [date, value] tuples', () => {
      METRICS.forEach((metric) => {
        PERIODS.forEach((period) => {
          response.data[metric][period].slice(0, 10).forEach(([date, value]) => {
            expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expectValidNumber(value);
          });
        });
      });
    });

    it('should be ordered newest-first within each series', () => {
      METRICS.forEach((metric) => {
        PERIODS.forEach((period) => {
          const series = response.data[metric][period];
          const times = series.map(([date]) => new Date(date).getTime());
          for (let i = 1; i < times.length; i++) {
            expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
          }
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/dimensions');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.DIMENSIONS('ZZZZNONEXISTENT'));
      expect(res.status).toBe(404);
    });
  });
});
