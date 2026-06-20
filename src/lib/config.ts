// Network configuration. Mainnet is the default; testnet is switchable.
// Each network lists interchangeable regional nodes (same genesis) for failover.

export type NetworkId = "mainnet" | "testnet";

export interface Network {
  id: NetworkId;
  label: string;
  chainPath: string; // root chain
  nodes: string[]; // tried in order, failover on dead node / 5xx
}

export const NETWORKS: Record<NetworkId, Network> = {
  mainnet: {
    id: "mainnet",
    label: "Nexus Mainnet",
    chainPath: "Nexus",
    nodes: [
      "https://lattice-mainnet-iad.fly.dev",
      "https://lattice-mainnet-ams.fly.dev",
      "https://lattice-mainnet-sjc.fly.dev",
    ],
  },
  testnet: {
    id: "testnet",
    label: "Nexus Testnet",
    chainPath: "Nexus",
    nodes: [
      "https://lattice-testnet-iad.fly.dev",
      "https://lattice-testnet-ams.fly.dev",
      "https://lattice-testnet-sjc.fly.dev",
    ],
  },
};

export const DEFAULT_NETWORK: NetworkId = "mainnet";
