import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityMetadataResponse, isEquityMetadataResponse } from './types';
import { metadataSchema } from './schemas';
import { expectSuccessfulResponse, expectNonEmptyString } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { commonValidation } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

describe('Equities API - Metadata', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityMetadataResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityMetadataResponse>(
      endpoints.EQUITIES.METADATA(company.ticker, company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(response);
      expect(isEquityMetadataResponse(response.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, metadataSchema, 'Equities Metadata');
      expect(result.success).toBe(true);
    });

    it('should have required identity fields', () => {
      const data = response.data;
      expectNonEmptyString(data.ticker);
      expectNonEmptyString(data.name);
      expectNonEmptyString(data.country);
      expect(data.ticker.toUpperCase()).toBe(company.ticker.toUpperCase());
    });
  });

  describe('Data Validation', () => {
    it('should have a valid website URL when present', () => {
      const { website } = response.data;
      if (website) {
        expect(commonValidation.httpUrl.safeParse(website).success).toBe(true);
      }
    });

    it('should have a YYYY-MM-DD startDate when present', () => {
      const { startDate } = response.data;
      if (startDate) {
        expect(startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/metadata');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.METADATA('ZZZZNONEXISTENT'));
      expect(res.status).toBe(404);
    });
  });
});
