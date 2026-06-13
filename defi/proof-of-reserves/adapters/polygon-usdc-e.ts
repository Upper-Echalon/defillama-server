import { getBridgeLockAndMintAdapter } from '../utils/bridge';

/**
 * Polygon PoS bridged USDC (USDC.e on Polygon).
 *
 * USDC deposited at Polygon's RootChainManager on Ethereum is locked at the
 * ERC20 PredicateProxy and a checkpointed message lets users mint USDC.e on
 * Polygon. Reverse withdraws are honoured against the predicate's balance.
 *
 * USDC.e on Polygon is the original (Circle-pre-CCTP) bridged variant; it
 * coexists with native USDC issued through Circle's CCTP. The PoR check
 * here covers only the canonical-bridge leg — CCTP USDC is a separate mint-
 * burn protocol with no on-Ethereum lock.
 *
 * Addresses:
 *   USDC.e on Polygon: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
 *     — PolygonScan: "Circle: USDC.e Token"
 *   USDC on Ethereum:  0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
 *   ERC20 Predicate:   0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
 *     — Etherscan: "Polygon (Matic): ERC20 Bridge"
 */

const protocolId = 'polygon-usdc-e';

const mintedTokens = [
  {
    chain: 'polygon',
    address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e on Polygon PoS
  },
];

const reservesTokens = [
  {
    chain: 'ethereum',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Circle USDC on Ethereum
    owners: [
      '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf', // Polygon PoS ERC20 Predicate
    ],
  },
];

export default getBridgeLockAndMintAdapter(protocolId, mintedTokens, reservesTokens);
