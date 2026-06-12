import { chainChartFileResponse, resolveChainRoutePath } from "./chainRouteAliases";
import { fileResponse } from "./utils";

jest.mock("./utils", () => ({
  fileResponse: jest.fn(),
}));

describe("resolveChainRoutePath", () => {
  it("rewrites old chain labels to current chart file labels", () => {
    expect(resolveChainRoutePath("charts/Optimism")).toEqual("charts/OP Mainnet");
    expect(resolveChainRoutePath("v2/historicalChainTvl/xDai")).toEqual("v2/historicalChainTvl/Gnosis");
    expect(resolveChainRoutePath("lite/charts/OKExChain")).toEqual("lite/charts/OKTChain");
  });

  it("rewrites case variants of old chain labels", () => {
    expect(resolveChainRoutePath("charts/optimism")).toEqual("charts/OP Mainnet");
    expect(resolveChainRoutePath("charts/klaytn")).toEqual("charts/Kaia");
  });

  it("keeps non-chain routes and current labels unchanged", () => {
    expect(resolveChainRoutePath("chains")).toEqual("chains");
    expect(resolveChainRoutePath("charts/OP%20Mainnet")).toEqual("charts/OP%20Mainnet");
    expect(resolveChainRoutePath("charts/Ethereum")).toEqual("charts/Ethereum");
  });

  it("leaves malformed or unknown segments untouched", () => {
    expect(resolveChainRoutePath("charts/NonexistentChain")).toEqual("charts/NonexistentChain");
    expect(resolveChainRoutePath("charts/%ZZ")).toEqual("charts/%ZZ");
    expect(resolveChainRoutePath("charts/")).toEqual("charts/");
    expect(resolveChainRoutePath("charts/Ethereum/extra")).toEqual("charts/Ethereum/extra");
  });

  it("rejects chain segments with an encoded slash", () => {
    expect(resolveChainRoutePath("charts/Optimism%2Fextra")).toEqual("charts/Optimism%2Fextra");
    expect(resolveChainRoutePath("lite/charts/xDai%2F..")).toEqual("lite/charts/xDai%2F..");
  });
});

describe("chainChartFileResponse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("serves the current-label file for old-label requests", () => {
    const response = {};

    chainChartFileResponse("charts/Optimism", response as any);

    expect(fileResponse).toHaveBeenCalledWith("charts/OP Mainnet", response);
  });

  it("uses the requested path when there is no alias", () => {
    const response = {};

    chainChartFileResponse("charts/OP%20Mainnet", response as any);

    expect(fileResponse).toHaveBeenCalledWith("charts/OP%20Mainnet", response);
  });
});
