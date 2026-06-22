import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityOnchainResponse, isEquityOnchainResponse } from './types';
import { onchainSchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectNonEmptyString,
  expectNonNegativeNumber,
  expectValidNumber,
} from '../../utils/testHelpers';
import { validate, commonValidation } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';
import { getTestCompany, TestCompany } from './helpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

describe('Equities API - On-chain', () => {
  let company: TestCompany;
  let response: ApiResponse<EquityOnchainResponse>;

  beforeAll(async () => {
    company = await getTestCompany(apiClient);
    response = await apiClient.get<EquityOnchainResponse>(
      endpoints.EQUITIES.ONCHAIN(company.ticker, company.country)
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return a valid on-chain payload or 404', () => {
      if (response.status === 404) {
        expect(response.status).toBe(404);
        return;
      }
      expectSuccessfulResponse(response);
      expect(isEquityOnchainResponse(response.data)).toBe(true);
    });

    it('should validate against Zod schema when present', () => {
      if (response.status === 404) return;
      const result = validate(response.data, onchainSchema, 'Equities On-chain');
      expect(result.success).toBe(true);
    });

    it('should have perps and tokens arrays when present', () => {
      if (response.status === 404) return;
      expect(Array.isArray(response.data.perps)).toBe(true);
      expect(Array.isArray(response.data.tokens)).toBe(true);
    });
  });

  describe('Data Validation', () => {
    it('should have valid perp markets when present', () => {
      if (response.status === 404) return;
      response.data.perps.slice(0, 10).forEach((perp) => {
        expectNonEmptyString(perp.pair);
        expectNonEmptyString(perp.contractSlug);
        expect(commonValidation.url.safeParse(perp.tradeUrl).success).toBe(true);
        if (perp.price != null) expectValidNumber(perp.price);
        if (perp.volume24h != null) expectNonNegativeNumber(perp.volume24h);
        if (perp.openInterest != null) expectNonNegativeNumber(perp.openInterest);
      });
    });

    it('should have valid tokenized issuers when present', () => {
      if (response.status === 404) return;
      response.data.tokens.slice(0, 10).forEach((token) => {
        expectNonEmptyString(token.issuer);
        expectNonEmptyString(token.assetSlug);
        if (token.price != null) expectValidNumber(token.price);
        if (token.activeMarketcap != null) expectNonNegativeNumber(token.activeMarketcap);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should return 400 when ticker is missing', async () => {
      const res = await apiClient.get('/v1/onchain');
      expect(res.status).toBe(400);
    });

    it('should return 404 for a non-existent ticker', async () => {
      const res = await apiClient.get(endpoints.EQUITIES.ONCHAIN('ZZZZNONEXISTENT'));
      expect(res.status).toBe(404);
    });
  });
});
