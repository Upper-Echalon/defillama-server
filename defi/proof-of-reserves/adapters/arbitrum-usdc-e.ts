import { getBridgeLockAndMintAdapter } from '../utils/bridge';

/**
 * Arbitrum One bridged USDC (USDC.e on Arbitrum).
 *
 * USDC deposited through Arbitrum's L1 Custom Gateway on Ethereum is locked
 * at that gateway address and an L2 message authorises the mint of USDC.e
 * on Arbitrum. Withdrawals burn USDC.e and release the locked USDC after
 * the canonical 7-day challenge period.
 *
 * USDC.e is the original (pre-Circle-native) bridged variant on Arbitrum;
 * it now coexists with Circle's native USDC. PoR here covers only the
 * canonical-bridge leg — native USDC uses CCTP and has no L1 lock.
 *
 * Addresses:
 *   USDC.e on Arbitrum: 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8
 *     — Arbiscan: "Bridged USDC (USDC.e)"
 *   USDC on Ethereum:   0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
 *   L1 Custom Gateway:  0xcEe284F754E854890e311e3280b767F80797180d
 *     — Etherscan: "Arbitrum One: L1 USDC Custom Gateway"
 */

const protocolId = 'arbitrum-usdc-e';

const mintedTokens = [
  {
    chain: 'arbitrum',
    address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e on Arbitrum One
  },
];

const reservesTokens = [
  {
    chain: 'ethereum',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Circle USDC on Ethereum
    owners: [
      '0xcee284f754e854890e311e3280b767f80797180d', // Arbitrum L1 USDC Custom Gateway
    ],
  },
];

export default getBridgeLockAndMintAdapter(protocolId, mintedTokens, reservesTokens);
