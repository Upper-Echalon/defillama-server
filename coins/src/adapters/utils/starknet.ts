// https://www.starknetjs.com/docs/API/contract
// https://playground.open-rpc.org/?uiSchema%5BappBar%5D%5Bui:splitView%5D=false&schemaUrl=https://raw.githubusercontent.com/starkware-libs/starknet-specs/master/api/starknet_api_openrpc.json&uiSchema%5BappBar%5D%5Bui:input%5D=false&uiSchema%5BappBar%5D%5Bui:darkMode%5D=true&uiSchema%5BappBar%5D%5Bui:examplesDropdown%5D=false
// https://docs.alchemy.com/reference/starknet-getevents
import {
  Contract,
  validateAndParseAddress,
  hash,
  CallData,
  num,
} from "starknet";
import axios from "axios";
import * as sdk from "@defillama/sdk";

const { sliceIntoChunks } = sdk.util;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STARKNET_RPC =
  process.env.STARKNET_RPC ?? "https://starknet-mainnet.public.blastapi.io";

// On-chain Multicall aggregator. Collapses N starknet_call executions into a
// single one (the node executes all sub-calls in one call frame), which is the
// real cost win when the RPC bills per sub-call rather than per HTTP request.
// aggregate(calls: Array<Call>) -> (block_number: u64, results: Array<Span<felt252>>)
// NOTE: aggregate reverts atomically — if any sub-call reverts, the whole call
// reverts — so callers fall back to per-call batching to preserve permitFailure.
const MULTICALL_AGGREGATOR =
  process.env.STARKNET_MULTICALL ??
  "0x01a33330996310a1e3fa1df5b16c1e07f0491fdd20c441126e02613b948f0225";
const AGGREGATE_CHUNK_SIZE = 50;

function formCallBody(
  { abi, target, params = [], allAbi = [] }: any,
  id: any = 0,
) {
  if ((params || params === 0) && !Array.isArray(params)) params = [params];
  const contract = new Contract([abi, ...allAbi], target, null as any);
  const requestData: any = contract.populate(abi.name, params);
  requestData.entry_point_selector = hash.getSelectorFromName(
    requestData.entrypoint,
  );
  requestData.contract_address = requestData.contractAddress;
  delete requestData.contractAddress;
  delete requestData.entrypoint;
  if (abi.customInput === 'address') requestData.calldata = params
  // Starknet RPC now (2026-06-11) rejects calls without 0x prefix
  // if (abi.customInput === 'address') requestData.calldata = params.map(i => i.slice(2))
  return getCallBody(requestData);

  function getCallBody(i: any) {
    return {
      jsonrpc: "2.0",
      id,
      method: "starknet_call",
      params: [i, "latest"],
    };
  }
}

function parseOutput(result: any, abi: any, allAbi: any) {
  let response: any = new CallData([abi, ...allAbi]).parse(abi.name, result);
  // convert BigInt to string
  for (const key in response) {
    if (typeof response[key] === "bigint")
      response[key] = response[key].toString();
  }

  if (abi.outputs.length === 1 && !abi.outputs[0].type.includes("::")) {
    response = response[abi.outputs[0].name];
    if (abi.outputs[0].type === "Uint256") return +response;
    switch (abi.customType) {
      case "address":
        return validateAndParseAddress(response);
      case "Uint256":
        return +response;
    }
  }
  return response;
}

export async function call({
  abi,
  target,
  params = [],
  allAbi = [],
}: any = {}) {
  const {
    data: { result },
  } = await axios.post(
    STARKNET_RPC,
    formCallBody({ abi, target, params, allAbi }),
  );
  return parseOutput(result, abi, allAbi);
}

export async function multiCall({
  abi: rootAbi,
  target: rootTarget,
  calls = [],
  allAbi = [],
  useAggregator = true,
}: any = {}) {
  if (!calls.length) return [];
  calls = calls.map((callArgs: any) => {
    if (typeof callArgs !== "object") {
      // a bare target string
      return { target: callArgs, params: [], abi: rootAbi };
    }
    const { target, params, abi } = callArgs;
    return { target: target || rootTarget, params, abi: abi || rootAbi };
  });

  // On-chain aggregation is the whole point: it collapses N sub-calls into one
  // RPC execution. Falling back to per-call batching would cost the same as not
  // batching at all, so by default we let aggregate failures propagate rather
  // than silently degrading. Pass useAggregator:false to opt into the per-call
  // path (e.g. when you need per-call failure tolerance over cost).
  if (useAggregator) return await aggregateMultiCall({ calls, rootAbi, allAbi });

  return await batchedMultiCall({ calls, rootAbi, allAbi });
}

// One starknet_call to the on-chain aggregator covering all sub-calls.
async function aggregateMultiCall({ calls, rootAbi, allAbi }: any) {
  const response: any[] = [];
  const chunks = sliceIntoChunks(calls, AGGREGATE_CHUNK_SIZE);
  let offset = 0;
  for (const chunk of chunks) {
    await sleep(200);
    // Build the Call[] calldata: [n, (to, selector, calldata_len, ...calldata) x n]
    const aggCalldata: any[] = [num.toHex(chunk.length)];
    chunk.forEach((c: any) => {
      const body = formCallBody(c).params[0] as any;
      aggCalldata.push(body.contract_address);
      aggCalldata.push(body.entry_point_selector);
      aggCalldata.push(num.toHex(body.calldata.length));
      body.calldata.forEach((d: any) => aggCalldata.push(d));
    });
    const aggSelector = hash.getSelectorFromName("aggregate");
    const reqBody = {
      jsonrpc: "2.0",
      id: 0,
      method: "starknet_call",
      params: [
        {
          contract_address: MULTICALL_AGGREGATOR,
          entry_point_selector: aggSelector,
          calldata: aggCalldata,
        },
        "latest",
      ],
    };
    const { data } = await axios.post(STARKNET_RPC, reqBody);
    if (!data.result)
      throw new Error(
        data.error?.data?.revert_error ??
          data.error?.message ??
          "aggregate failed",
      );
    // result layout: [block_number, results_len, (span_len, ...span_felts) x results_len]
    const result = data.result;
    let i = 1; // skip block_number
    const resultsLen = +num.toBigInt(result[i++]).toString();
    for (let j = 0; j < resultsLen; j++) {
      const spanLen = +num.toBigInt(result[i++]).toString();
      const span = result.slice(i, i + spanLen);
      i += spanLen;
      const abi = chunk[j].abi ?? rootAbi;
      response[offset + j] = parseOutput(span, abi, allAbi);
    }
    offset += chunk.length;
  }
  return response;
}

// Fallback path: N individual starknet_call requests packed into HTTP batches.
async function batchedMultiCall({ calls, rootAbi, allAbi }: any) {
  const callBodies = calls.map((c: any, id: number) => formCallBody(c, id));
  const allData: any[] = [];
  const chunks = sliceIntoChunks(callBodies, 25);
  for (const chunk of chunks) {
    const {
      data,
    }: any = await axios.post(STARKNET_RPC, chunk);
    allData.push(...data);
  }
  // responses may come back out of order; align by id
  allData.sort((a, b) => a.id - b.id);
  return calls.map((c: any, idx: number) => {
    const abi = c.abi ?? rootAbi;
    return parseOutput(allData[idx].result, abi, allAbi);
  });
}

export function feltArrToStr(felts: bigint[]): string {
  return felts.reduce(
    (memo, felt) => memo + Buffer.from(felt.toString(16), "hex").toString(),
    "",
  );
}

export const cairoErc20Abis = {
  name: {
    name: "name",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "core::felt252",
      },
    ],
    state_mutability: "view",
  },
  symbol: {
    name: "symbol",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "core::felt252",
      },
    ],
    state_mutability: "view",
  },
  decimals: {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "core::integer::u8",
      },
    ],
    state_mutability: "view",
  },
  totalSupply: {
    name: "total_supply",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "core::integer::u256",
      },
    ],
    state_mutability: "view",
  },
  balanceOf: {
    name: "balance_of",
    type: "function",
    inputs: [
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
    outputs: [
      {
        type: "core::integer::u256",
      },
    ],
    state_mutability: "view",
  },
};
