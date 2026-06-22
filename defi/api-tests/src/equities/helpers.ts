import { ApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { EquityCompanyListItem } from './types';

const PREFERRED_TICKERS = ['NVDA', 'AAPL', 'MSFT'];

export interface TestCompany {
  ticker: string;
  country: string;
}

export async function getTestCompany(apiClient: ApiClient): Promise<TestCompany> {
  const res = await apiClient.get<EquityCompanyListItem[]>(endpoints.EQUITIES.COMPANIES_LIST);
  const list = Array.isArray(res.data) ? res.data : [];

  if (list.length === 0) {
    throw new Error('Equities companies-list returned no companies');
  }

  const preferred = list.find((c) => PREFERRED_TICKERS.includes(c.ticker?.toUpperCase()));
  const chosen = preferred ?? list[0];
  return { ticker: chosen.ticker, country: chosen.country };
}

export const MAX_STALENESS_DAYS = 5;

export function expectFresh(
  latest: string | number,
  label: string,
  maxDays: number = MAX_STALENESS_DAYS
): void {
  const ms = typeof latest === 'number' ? latest * 1000 : new Date(latest).getTime();

  expect(Number.isNaN(ms)).toBe(false);
  expect(ms).toBeGreaterThan(0);

  const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
  if (ageDays > maxDays) {
    throw new Error(
      `${label} is stale: most recent data is ${ageDays.toFixed(1)} days old (max ${maxDays})`
    );
  }
}
