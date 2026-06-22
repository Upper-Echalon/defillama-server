import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityFilingsResponse } from './types';
import { filingsArraySchema } from './schemas';
import { expectSuccessfulResponse, expectNonEmptyString } from '../../utils/testHelpers';
import { validate, commonValidation } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { EquityCompanyListItem } from './types';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

const PREFERRED_US = ['NVDA', 'AAPL', 'MSFT'];

describe('Equities API - Filings', () => {
  let ticker: string;
  let response: ApiResponse<EquityFilingsResponse>;

  beforeAll(async () => {
    const listRes = await apiClient.get<EquityCompanyListItem[]>(
      endpoints.EQUITIES.COMPANIES_LIST
    );
    const list = Array.isArray(listRes.data) ? listRes.data : [];
    const usCompanies = list.filter((c) => c.country?.toUpperCase() === 'US');
    const preferred = usCompanies.find((c) => PREFERRED_US.includes(c.ticker?.toUpperCase()));
    ticker = (preferred ?? usCompanies[0])?.ticker;

    response = await apiClient.get<EquityFilingsResponse>(
      endpoints.EQUITIES.FILINGS(ticker, 'US')
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with an array', () => {
      expectSuccessfulResponse(response);
      expect(Array.isArray(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, filingsArraySchema, 'Equities Filings');
      expect(result.success).toBe(true);
    });
  });

  describe('Data Validation', () => {
    it('should have required keys and valid document URLs', () => {
      response.data.slice(0, 15).forEach((filing) => {
        expect(filing).toHaveProperty('filingDate');
        expect(filing).toHaveProperty('form');
        expect(filing).toHaveProperty('primaryDocumentUrl');
        expectNonEmptyString(filing.form);
        expect(filing.filingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(commonValidation.url.safeParse(filing.primaryDocumentUrl).success).toBe(true);
      });
    });

    it('should be ordered newest-first by filing date', () => {
      const dates = response.data.map((f) => new Date(f.filingDate).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/filings');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.FILINGS('ZZZZNONEXISTENT', 'US'));
      expect(res.status).toBe(404);
    });
  });
});
