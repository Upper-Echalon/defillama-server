import { z } from 'zod';
import {
  companySchema,
  companiesArraySchema,
  companyListItemSchema,
  companiesListArraySchema,
  statementSchema,
  priceHistoryArraySchema,
  ohlcvArraySchema,
  summarySchema,
  metadataSchema,
  filingSchema,
  filingsArraySchema,
  onchainSchema,
  dimensionsSchema,
} from './schemas';

export type EquityCompany = z.infer<typeof companySchema>;
export type EquityCompaniesResponse = z.infer<typeof companiesArraySchema>;
export type EquityCompanyListItem = z.infer<typeof companyListItemSchema>;
export type EquityCompaniesListResponse = z.infer<typeof companiesListArraySchema>;
export type EquityStatementsResponse = z.infer<typeof statementSchema>;
export type EquityPriceHistoryResponse = z.infer<typeof priceHistoryArraySchema>;
export type EquityOhlcvResponse = z.infer<typeof ohlcvArraySchema>;
export type EquitySummaryResponse = z.infer<typeof summarySchema>;
export type EquityMetadataResponse = z.infer<typeof metadataSchema>;
export type EquityFiling = z.infer<typeof filingSchema>;
export type EquityFilingsResponse = z.infer<typeof filingsArraySchema>;
export type EquityOnchainResponse = z.infer<typeof onchainSchema>;
export type EquityDimensionsResponse = z.infer<typeof dimensionsSchema>;

export function isEquityCompaniesResponse(data: any): data is EquityCompaniesResponse {
  return Array.isArray(data) && (data.length === 0 || typeof data[0]?.ticker === 'string');
}

export function isEquityCompaniesListResponse(data: any): data is EquityCompaniesListResponse {
  return Array.isArray(data) && (data.length === 0 || typeof data[0]?.companyName === 'string');
}

export function isEquitySummaryResponse(data: any): data is EquitySummaryResponse {
  return data != null && typeof data === 'object' && !Array.isArray(data);
}

export function isEquityMetadataResponse(data: any): data is EquityMetadataResponse {
  return data != null && typeof data === 'object' && typeof data.ticker === 'string';
}

export function isEquityOnchainResponse(data: any): data is EquityOnchainResponse {
  return (
    data != null &&
    typeof data === 'object' &&
    Array.isArray(data.perps) &&
    Array.isArray(data.tokens)
  );
}

export function isEquityDimensionsResponse(data: any): data is EquityDimensionsResponse {
  return data != null && typeof data === 'object' && typeof data.revenue === 'object';
}
