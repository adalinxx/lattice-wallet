// One node, one chain level. Every read names its chain with ?chainPath=; the
// node answers 404 for a level it does not host. A refusal keeps the node's
// own name for it (e.g. "feeTooLow", "full", "unknownChain").

export interface ChainInfo {
  chain: string[];
  genesisHash?: string | null;
  height?: number | null;
  tipCID?: string | null;
  /** Absent from nodes predating public submit: read as false. */
  acceptsSubmit?: boolean;
}
export interface AccountState {
  owner: string;
  balance: number;
  nonce: number;
}
export interface ExplorerTransaction {
  txCID: string;
  blockHeight?: number | null;
  blockHash?: string | null;
  nonce: number;
  signers: string[];
  chainPath: string[];
  accountActions: { owner: string; delta: number }[];
}
/**
 * Where a sent transaction stands. The node keeps no transaction-to-block
 * index (`blockHeight` is null), so inclusion is read from the signer's
 * nonce: once the account nonce passes the transaction's, that nonce is spent
 * (by this transaction, or by a replacement at the same nonce).
 */
export async function sentStatus(client: NodeClient, cid: string): Promise<"pending" | "nonce spent" | "not in pool" | "unknown to node"> {
  let tx: ExplorerTransaction;
  try {
    tx = await client.transaction(cid);
  } catch (e) {
    if (e instanceof NodeError && e.status === 404) return "unknown to node";
    throw e;
  }
  if ((await client.mempool()).transactions.includes(cid)) return "pending";
  const signer = tx.signers[0];
  if (signer && (await client.account(signer)).nonce > tx.nonce) return "nonce spent";
  return "not in pool";
}

export interface ChainEndpoints {
  chainPath: string[];
  committedBlock: string | null;
  endpoints: string[];
  /** Absent from nodes predating public submit: read as []. */
  submitEndpoints?: string[];
}
export interface SubmitAnswer {
  transactionCID: string;
  mempoolCount: number;
  mempoolBytes: number;
}

export class NodeError extends Error {
  readonly status: number;
  readonly refusal: string | null;
  constructor(status: number, refusal: string | null) {
    super(refusal ?? `HTTP ${status}`);
    this.status = status;
    this.refusal = refusal;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Hummingbird's error envelope is {"error":{"message":"..."}}. */
export function refusalOf(text: string): string | null {
  try {
    const body = JSON.parse(text);
    const message = body?.error?.message ?? body?.error ?? null;
    return typeof message === "string" && message ? message : null;
  } catch {
    return null;
  }
}

export class NodeClient {
  readonly baseURL: string;
  readonly chainPath: string[];
  private readonly fetchImpl: Fetch;
  constructor(baseURL: string, chainPath: string[], fetchImpl: Fetch = (input, init) => fetch(input, init)) {
    this.baseURL = baseURL;
    this.chainPath = chainPath;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(this.baseURL + path);
    url.searchParams.set("chainPath", this.chainPath.join("/"));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new NodeError(res.status, refusalOf(text));
    return JSON.parse(text) as T;
  }

  info() {
    return this.request<ChainInfo>(this.url("/api/chain/info"));
  }
  account(address: string) {
    return this.request<AccountState>(this.url(`/api/state/account/${encodeURIComponent(address)}`));
  }
  transaction(cid: string) {
    return this.request<ExplorerTransaction>(this.url(`/api/transaction/${encodeURIComponent(cid)}`));
  }
  /** A bounded listing of the pool's transaction CIDs. */
  mempool() {
    return this.request<{ count: number; transactions: string[] }>(this.url("/api/mempool"));
  }
  block(id: string) {
    return this.request<{ hash: string; height: number }>(this.url(`/api/block/${encodeURIComponent(id)}`));
  }
  /** The declared endpoints of `child`, a child of this client's level. */
  endpoints(child: string[]) {
    const url = new URL(this.baseURL + "/api/chain/endpoints");
    url.searchParams.set("chainPath", child.join("/"));
    return this.request<ChainEndpoints>(url.toString());
  }
  /** POST /transactions with a body produced by the signer. */
  submit(requestJSON: string) {
    return this.request<SubmitAnswer>(this.baseURL + "/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestJSON,
    });
  }
}
