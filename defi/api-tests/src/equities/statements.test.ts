import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityStatementsResponse } from './types';
import { statementSchema } from './schemas';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

const SECTIONS = ['incomeStatement', 'balanceSheet', 'cashflow'] as const;

describe('Equities API - Statements', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityStatementsResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityStatementsResponse>(
      endpoints.EQUITIES.STATEMENTS(company.ticker, company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with an object payload', () => {
      expectSuccessfulResponse(response);
      expect(typeof response.data).toBe('object');
      expect(response.data).not.toBeNull();
      expect(Array.isArray(response.data)).toBe(false);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, statementSchema, 'Equities Statements');
      expect(result.success).toBe(true);
    });

    it('should expose at least one statement section', () => {
      const present = SECTIONS.filter((s) => response.data[s] != null);
      expect(present.length).toBeGreaterThan(0);
    });
  });

  describe('Data Validation', () => {
    it('should have aligned labels and value rows for each present section', () => {
      SECTIONS.forEach((sectionKey) => {
        const section = response.data[sectionKey];
        if (!section) return;

        expect(Array.isArray(section.labels)).toBe(true);

        (['annual', 'quarterly'] as const).forEach((period) => {
          const series = section[period];
          if (!series) return;

          expect(Array.isArray(series.periodEnding)).toBe(true);
          expect(Array.isArray(series.values)).toBe(true);

          // One value row per label.
          expect(series.values.length).toBe(section.labels.length);

          // Each value row is aligned to periodEnding.
          series.values.slice(0, 5).forEach((row) => {
            expect(Array.isArray(row)).toBe(true);
            expect(row.length).toBe(series.periodEnding.length);
          });
        });
      });
    });

    it('should have ascending periodEnding dates when present', () => {
      SECTIONS.forEach((sectionKey) => {
        const section = response.data[sectionKey];
        if (!section) return;

        (['annual', 'quarterly'] as const).forEach((period) => {
          const series = section[period];
          if (!series || series.periodEnding.length < 2) return;

          for (let i = 1; i < series.periodEnding.length; i++) {
            expect(series.periodEnding[i] >= series.periodEnding[i - 1]).toBe(true);
          }
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/statements');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.STATEMENTS('ZZZZNONEXISTENT'));
      expect(res.status).toBe(404);
    });
  });
});
