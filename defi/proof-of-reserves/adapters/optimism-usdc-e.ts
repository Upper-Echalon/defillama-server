import { getBridgeLockAndMintAdapter } from '../utils/bridge';

/**
 * Optimism bridged USDC (USDC.e on Optimism).
 *
 * USDC deposited through Optimism's L1StandardBridge is locked there and
 * the OP rollup mints USDC.e on Optimism for the depositor. Withdrawals
 * burn USDC.e on L2, the standard 7-day challenge period elapses, and the
 * locked USDC is released to the user on Ethereum.
 *
 * USDC.e is the legacy bridged variant. Circle's native USDC on Optimism
 * (separate, CCTP-based) coexists alongside it; this adapter does not
 * cover native USDC because CCTP is mint-burn and has no on-chain lock.
 *
 * Addresses:
 *   USDC.e on Optimism:    0x7F5c764cBc14f9669B88837ca1490cCa17c31607
 *     — OP Etherscan: "USD Coin (Bridged from Ethereum) (USDC.e)"
 *   USDC on Ethereum:      0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
 *   L1 Standard Bridge:    0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1
 *     — Etherscan: "Optimism: L1 Standard Bridge"
 */

const protocolId = 'optimism-usdc-e';

const mintedTokens = [
  {
    chain: 'optimism',
    address: '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e on Optimism
  },
];

const reservesTokens = [
  {
    chain: 'ethereum',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Circle USDC on Ethereum
    owners: [
      '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', // Optimism L1 Standard Bridge
    ],
  },
];

export default getBridgeLockAndMintAdapter(protocolId, mintedTokens, reservesTokens);
