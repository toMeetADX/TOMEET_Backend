import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28"
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 }
        }
      }
    }
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1"
    },
    injectiveTestnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("INJECTIVE_EVM_TESTNET_RPC_URL"),
      accounts: [configVariable("RELATIONSHIP_RELAYER_PRIVATE_KEY")]
    },
    injectiveMainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("INJECTIVE_EVM_MAINNET_RPC_URL"),
      accounts: [configVariable("RELATIONSHIP_RELAYER_PRIVATE_KEY")]
    }
  }
});
