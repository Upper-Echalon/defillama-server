import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const finiteNumber = z.number().finite();
const nonNegativeNumber = z.number().nonnegative().finite();
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, { message: 'Invalid date' });

// ============================================================================
// GET /v1/companies
// ============================================================================

export const companySchema = z
  .object({
    ticker: nonEmptyString,
    country: nonEmptyString,
    name: nonEmptyString,
    sector: z.string(),
    industry: z.string(),
    employeeCount: nonNegativeNumber.nullable(),
    updatedAt: z.string(),
    // Market data
    currentPrice: nonNegativeNumber.nullable(),
    volume: nonNegativeNumber.nullable(),
    marketCap: nonNegativeNumber.nullable(),
    circulatingMarketCap: nonNegativeNumber.nullable(),
    enterpriseValue: finiteNumber.nullable(),
    fiftyTwoWeekHigh: nonNegativeNumber.nullable(),
    fiftyTwoWeekLow: nonNegativeNumber.nullable(),
    priceChange1d: finiteNumber.nullable(),
    priceChangePercentage1d: finiteNumber.nullable(),
    priceChangePercentage7d: finiteNumber.nullable(),
    priceChangePercentage1m: finiteNumber.nullable(),
    marketCapChange1d: finiteNumber.nullable(),
    circulatingSupply: nonNegativeNumber.nullable(),
    totalSupply: nonNegativeNumber.nullable(),
    // Valuation ratios
    trailingPE: finiteNumber.nullable(),
    priceToBook: finiteNumber.nullable(),
    priceToRevenue: finiteNumber.nullable(),
    enterpriseValueToEbitda: finiteNumber.nullable(),
    dividendYield: finiteNumber.nullable(),
    holdersYield: finiteNumber.nullable(),
    // Trailing-twelve-month fundamentals
    revenueTTM: finiteNumber.nullable(),
    grossProfitTTM: finiteNumber.nullable(),
    earningsTTM: finiteNumber.nullable(),
    ebitdaTTM: finiteNumber.nullable(),
    operatingProfitMarginTTM: finiteNumber.nullable(),
    holdersRevenueTTM: finiteNumber.nullable(),
    holderEarningsTTM: finiteNumber.nullable(),
    dividendsTTM: finiteNumber.nullable(),
    stockRepurchaseTTM: finiteNumber.nullable(),
    stockIssuanceTTM: finiteNumber.nullable(),
    stockBasedCompensationTTM: finiteNumber.nullable(),
    // Balance sheet
    cashAndCashEquivalents: finiteNumber.nullable(),
    totalAssets: finiteNumber.nullable(),
    totalLiabilities: finiteNumber.nullable(),
    totalShareholdersEquity: finiteNumber.nullable(),
    totalDebt: finiteNumber.nullable(),
  })
  .passthrough();

export const companiesArraySchema = z.array(companySchema);

// ============================================================================
// GET /v1/companies-list
// ============================================================================

export const companyListItemSchema = z
  .object({
    ticker: nonEmptyString,
    companyName: nonEmptyString,
    country: nonEmptyString,
    countryName: nonEmptyString,
  })
  .passthrough();

export const companiesListArraySchema = z.array(companyListItemSchema);

// ============================================================================
// GET /v1/statements – { incomeStatement, balanceSheet, cashflow }
// Each section: top-level `labels`, a `children` label-map, and annual/quarterly
// series of `periodEnding` dates + `values` rows (one (number|null)[] per label).
// ============================================================================

const statementValueRow = z.array(finiteNumber.nullable());

const statementSeriesSchema = z
  .object({
    periodEnding: z.array(z.string()),
    values: z.array(statementValueRow),
    children: z.record(z.string(), z.object({ values: z.array(statementValueRow) }).passthrough()),
  })
  .passthrough();

const statementLabelGroup = z.record(
  z.string(),
  z.object({ labels: z.array(z.string()) }).passthrough()
);

const statementSectionSchema = z
  .object({
    labels: z.array(z.string()),
    children: z
      .object({
        annual: statementLabelGroup,
        quarterly: statementLabelGroup,
      })
      .passthrough(),
    annual: statementSeriesSchema,
    quarterly: statementSeriesSchema,
  })
  .passthrough();

// A statements payload may omit individual sections, so each is optional.
export const statementSchema = z
  .object({
    incomeStatement: statementSectionSchema.optional(),
    balanceSheet: statementSectionSchema.optional(),
    cashflow: statementSectionSchema.optional(),
  })
  .passthrough();

// ============================================================================
// GET /v1/price-history — array of [date, price]
// ============================================================================

export const priceHistoryTupleSchema = z.tuple([z.string(), finiteNumber]);

export const priceHistoryArraySchema = z.array(priceHistoryTupleSchema);

// ============================================================================
// GET /v1/ohlcv — array of [unixSeconds, open, high, low, close, volume]
// ============================================================================

export const ohlcvTupleSchema = z.tuple([
  z.number().int(), // unixSeconds
  finiteNumber, // open
  finiteNumber, // high
  finiteNumber, // low
  finiteNumber, // close
  nonNegativeNumber, // volume
]);

export const ohlcvArraySchema = z.array(ohlcvTupleSchema);

// ============================================================================
// GET /v1/summary
// ============================================================================

export const summarySchema = z
  .object({
    currentPrice: nonNegativeNumber.nullable(),
    volume: nonNegativeNumber.nullable(),
    marketCap: nonNegativeNumber.nullable(),
    fiftyTwoWeekHigh: nonNegativeNumber.nullable(),
    fiftyTwoWeekLow: nonNegativeNumber.nullable(),
    dividendYield: finiteNumber.nullable(),
    trailingPE: finiteNumber.nullable(),
    priceChangePercentage1d: finiteNumber.nullable(),
    priceToBook: finiteNumber.nullable(),
    updatedAt: z.string(),
    priceChangePercentage7d: finiteNumber.nullable(),
    priceChangePercentage1m: finiteNumber.nullable(),
    revenueTTM: finiteNumber.nullable(),
    grossProfitTTM: finiteNumber.nullable(),
    totalAssets: finiteNumber.nullable(),
    earningsTTM: finiteNumber.nullable(),
  })
  .passthrough()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Summary must have at least one key',
  });

// ============================================================================
// GET /v1/metadata
// ============================================================================

export const metadataSchema = z
  .object({
    ticker: nonEmptyString,
    name: nonEmptyString,
    country: nonEmptyString,
    sector: z.string(),
    industry: z.string(),
    employeeCount: nonNegativeNumber.nullable(),
    website: z.string(),
    description: z.string(),
    startDate: dateString,
  })
  .passthrough();

// ============================================================================
// GET /v1/filings
// ============================================================================

export const filingSchema = z
  .object({
    filingDate: dateString,
    // Some filings (e.g. certain 8-Ks) have no report date — it comes back as "".
    reportDate: z.union([dateString, z.literal(''), z.null()]),
    form: nonEmptyString,
    primaryDocumentUrl: z.string().url(),
    documentDescription: z.string(),
  })
  .passthrough();

export const filingsArraySchema = z.array(filingSchema);

// ============================================================================
// GET /v1/onchain — { perps, tokens }
// ============================================================================

export const perpDataSchema = z
  .object({
    pair: nonEmptyString,
    price: finiteNumber.nullable(),
    volume24h: nonNegativeNumber.nullable(),
    openInterest: nonNegativeNumber.nullable(),
    annualizedFundingRate: finiteNumber.nullable(),
    tradeUrl: z.string().url(),
    contractSlug: nonEmptyString,
    exchangeProtocolSlug: z.string().optional(),
    rwaPlatformSlug: z.string().optional(),
    updatedAt: z.string(),
  })
  .passthrough();

export const tokenDataSchema = z
  .object({
    issuer: nonEmptyString,
    issuerRwaPlatformSlug: nonEmptyString,
    price: finiteNumber.nullable(),
    assetSlug: nonEmptyString,
    activeMarketcap: nonNegativeNumber.nullable(),
  })
  .passthrough();

export const onchainSchema = z
  .object({
    perps: z.array(perpDataSchema),
    tokens: z.array(tokenDataSchema),
  })
  .passthrough();

// ============================================================================
// GET /v1/dimensions — series of [date, value] tuples per metric
// ============================================================================

export const dimensionPointSchema = z.tuple([dateString, finiteNumber]);

export const dimensionSeriesSchema = z
  .object({
    annual: z.array(dimensionPointSchema),
    quarterly: z.array(dimensionPointSchema),
  })
  .passthrough();

export const dimensionsSchema = z
  .object({
    revenue: dimensionSeriesSchema,
    holdersRevenue: dimensionSeriesSchema,
    earnings: dimensionSeriesSchema,
  })
  .passthrough();
