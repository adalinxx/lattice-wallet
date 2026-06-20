// RPC client with multi-node failover (same pattern as the explorer). Reads
// start at the active node and fail over to the next on a dead node or 5xx; a
// 4xx (e.g. 404) is a valid answer and never triggers failover.

import { NETWORKS, type NetworkId, type Network } from "../config.ts";

export interface SubmitResult {
  accepted: boolean;
  txCID?: string;
  error?: string | null;
}

export class RpcClient {
  private nodeIdx = 0;
  constructor(private network: Network) {}

  static for(id: NetworkId): RpcClient {
    return new RpcClient(NETWORKS[id]);
  }

  get activeNode(): string {
    return this.network.nodes[this.nodeIdx];
  }

  private rotate() {
    this.nodeIdx = (this.nodeIdx + 1) % this.network.nodes.length;
  }

  private async call<T>(path: string, params?: Record<string, string>, init?: RequestInit): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.network.nodes.length; attempt++) {
      const url = new URL(this.activeNode + path);
      url.searchParams.set("chainPath", this.network.chainPath);
      if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
      } catch (e) {
        lastErr = e;
        this.rotate();
        continue;
      }
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (res.ok) return body as T;
      if (res.status >= 500 && attempt < this.network.nodes.length - 1) {
        lastErr = new Error(body?.error ?? `HTTP ${res.status}`);
        this.rotate();
        continue;
      }
      const err = new Error(body?.error ?? `HTTP ${res.status}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    throw lastErr ?? new Error("all nodes unreachable");
  }

  health() {
    return this.call<{ status: string; chainHeight: number; peerCount: number }>("/health");
  }
  balance(address: string) {
    return this.call<{ address: string; balance: number }>(`/api/balance/${encodeURIComponent(address)}`);
  }
  nonce(address: string) {
    return this.call<{ address: string; nonce: number }>(`/api/nonce/${encodeURIComponent(address)}`);
  }
  feeEstimate(target = 5) {
    return this.call<{ fee: number; target: number }>("/api/fee/estimate", { target: String(target) });
  }
  history(address: string, limit = 25) {
    return this.call<{ transactions: { txCID: string; blockHash: string; height: number }[]; nextCursor: string | null }>(
      `/api/transactions/${encodeURIComponent(address)}`,
      { limit: String(limit) },
    );
  }
  prepareBodyCID(payload: unknown) {
    return this.call<{ bodyCID: string; bodyData: string; signingPreimage: string }>("/api/transaction/prepare", undefined, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  submit(payload: { signatures: Record<string, string>; bodyCID: string; bodyData: string; chainPath: string[] }) {
    return this.call<SubmitResult>("/api/transaction", undefined, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}
