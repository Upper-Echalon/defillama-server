import { getBridgeLockAndMintAdapter } from '../utils/bridge';

/**
 * Stargate v2 EURC.e on Tempo Mainnet (chainId 4217).
 *
 * Same Hydra v2 OFT mechanism as Tempo USDC.e — EURC deposited on Ethereum
 * is locked at the Stargate v2 EURC Pool, a LayerZero V2 message credits
 * the OFT on Tempo, and EURC.e is minted to the user. Burns reverse the
 * flow.
 *
 * Tempo is currently the sole consumer of the Stargate v2 EURC Pool, so
 * the Pool balance and Tempo EURC.e supply line up at ~1:1 (verified at
 * deployment time both showed identical raw balances). The check therefore
 * acts as a tight peg verification, not just a safety floor.
 *
 * EURC contract addresses sourced from:
 *   - Tempo's tokenlist (tokenlist.tempo.xyz/list/4217)
 *   - Stargate v2 deployment manifest (StargatePoolEURC.json on ethereum-mainnet)
 *   - Circle's EURC on Ethereum (0x1abaea1f7c830bd89acc67ec4af516284b1bc33c)
 */

const protocolId = 'tempo-eurc-e';

const mintedTokens = [
  {
    chain: 'tempo',
    address: '0x20c0000000000000000000001621e21F71CF12fb', // EURC.e on Tempo (TIP-20)
  },
];

const reservesTokens = [
  {
    chain: 'ethereum',
    address: '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c', // Circle EURC on Ethereum
    owners: [
      '0x783129E4d7bA0Af0C896c239E57C06DF379aAE8c', // Stargate v2 EURC Pool
    ],
  },
];

export default getBridgeLockAndMintAdapter(protocolId, mintedTokens, reservesTokens);
