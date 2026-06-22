import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import {
  EquityCompaniesResponse,
  EquityCompaniesListResponse,
  isEquityCompaniesResponse,
  isEquityCompaniesListResponse,
} from './types';
import { companiesArraySchema, companiesListArraySchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectNonEmptyArray,
  expectNonEmptyString,
  expectNonNegativeNumber,
  expectValidNumber,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { expectCorsHeaders } from '../../utils/corsHelpers';

const apiClient = createApiClient(endpoints.EQUITIES.BASE_URL);

describe('Equities API - Companies List', () => {
  let response: ApiResponse<EquityCompaniesListResponse>;

  beforeAll(async () => {
    response = await apiClient.get<EquityCompaniesListResponse>(endpoints.EQUITIES.COMPANIES_LIST);
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(response);
      expect(Array.isArray(response.data)).toBe(true);
      expect(isEquityCompaniesListResponse(response.data)).toBe(true);
      expectNonEmptyArray(response.data);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, companiesListArraySchema, 'Equities Companies List');
      expect(result.success).toBe(true);
    });

    it('should have required identity fields on each item', () => {
      response.data.slice(0, 25).forEach((item) => {
        expectNonEmptyString(item.ticker);
        expectNonEmptyString(item.companyName);
        expectNonEmptyString(item.country);
        expectNonEmptyString(item.countryName);
      });
    });
  });

  describe('Data Validation', () => {
    it('should use ISO-2 uppercase country codes', () => {
      response.data.slice(0, 50).forEach((item) => {
        expect(item.country).toMatch(/^[A-Z]{2}$/);
      });
    });
  });
});

describe('Equities API - Companies', () => {
  let response: ApiResponse<EquityCompaniesResponse>;

  beforeAll(async () => {
    response = await apiClient.get<EquityCompaniesResponse>(endpoints.EQUITIES.COMPANIES);
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(response);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(response);
      expect(Array.isArray(response.data)).toBe(true);
      expect(isEquityCompaniesResponse(response.data)).toBe(true);
      expectNonEmptyArray(response.data);
    });

    it('should validate against Zod schema', () => {
      const result = validate(response.data, companiesArraySchema, 'Equities Companies');
      expect(result.success).toBe(true);
    });

    it('should have required keys on each company', () => {
      response.data.slice(0, 25).forEach((company) => {
        expect(company).toHaveProperty('ticker');
        expect(company).toHaveProperty('country');
        expect(company).toHaveProperty('name');
        expect(company).toHaveProperty('sector');
        expect(company).toHaveProperty('industry');
        expect(company).toHaveProperty('marketCap');
        expect(company).toHaveProperty('updatedAt');
        expectNonEmptyString(company.ticker);
        expectNonEmptyString(company.name);
      });
    });
  });

  describe('Data Validation', () => {
    it('should have valid market metrics when present', () => {
      response.data.slice(0, 25).forEach((company) => {
        if (company.currentPrice != null) expectNonNegativeNumber(company.currentPrice);
        if (company.volume != null) expectNonNegativeNumber(company.volume);
        if (company.marketCap != null) expectNonNegativeNumber(company.marketCap);
        if (company.priceChangePercentage1d != null) {
          expectValidNumber(company.priceChangePercentage1d);
        }
      });
    });

    it('should be sorted by market cap descending', () => {
      const caps = response.data
        .map((c) => c.marketCap)
        .filter((cap): cap is number => typeof cap === 'number');

      for (let i = 1; i < caps.length; i++) {
        expect(caps[i]).toBeLessThanOrEqual(caps[i - 1]);
      }
    });

    it('should have unique ticker+country pairs', () => {
      const keys = response.data.map((c) => `${c.ticker}:${c.country}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
