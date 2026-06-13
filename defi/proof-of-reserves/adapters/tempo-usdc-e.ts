import { getBridgeLockAndMintAdapter } from '../utils/bridge';

/**
 * Stargate v2 USDC.e on Tempo Mainnet (chainId 4217).
 *
 * Mint flow: USDC deposited on Ethereum is locked at the Stargate v2 USDC
 * Pool, a LayerZero V2 Hydra message credits the OFT on Tempo, and the OFT
 * mints USDC.e to the user. The reverse flow burns USDC.e on Tempo and
 * unlocks USDC from the Pool.
 *
 * Note on backing %: the Stargate v2 USDC Pool aggregates reserves across
 * every Hydra v2 chain that uses USDC. The reported backing ratio is
 * therefore an aggregated multi-chain upper-bound, not a tight Tempo-
 * specific PoR. The default <95% alert acts only as a safety floor — it
 * trips if the shared Pool ever drops below Tempo's individual leg, which
 * would signal a serious accounting break across all Hydra v2 USDC
 * variants.
 *
 * TODO: tighten to a Tempo-specific PoR once Stargate exposes per-chain
 * locked balances on-chain (currently the Pool is a single shared bucket).
 *
 * Tempo USDC.e address sourced from Tempo's official tokenlist registry
 * (https://tokenlist.tempo.xyz/list/4217). Stargate v2 USDC Pool address
 * sourced from the official deployment manifest at
 * github.com/stargate-protocol/stargate-v2/.../ethereum-mainnet/StargatePoolUSDC.json.
 */

const protocolId = 'tempo-usdc-e';

const mintedTokens = [
  {
    chain: 'tempo',
    address: '0x20C000000000000000000000b9537d11c60E8b50', // USDC.e on Tempo (TIP-20)
  },
];

const reservesTokens = [
  {
    chain: 'ethereum',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC on Ethereum
    owners: [
      '0xc026395860Db2d07ee33e05fE50ed7bD583189C7', // Stargate v2 USDC Pool
    ],
  },
];

export default getBridgeLockAndMintAdapter(protocolId, mintedTokens, reservesTokens);
