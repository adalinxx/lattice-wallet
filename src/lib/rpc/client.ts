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
  balance: bigint;
  nonce: bigint;
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
export async function sentStatus(client: NodeClient, cid: string): Promise<"pending" | "nonce spent" | "pending or dropped" | "unknown to node"> {
  let tx: ExplorerTransaction;
  try {
    tx = await client.transaction(cid);
  } catch (e) {
    if (e instanceof NodeError && e.status === 404) return "unknown to node";
    throw e;
  }
  if ((await client.mempool()).transactions.includes(cid)) return "pending";
  const signer = tx.signers[0];
  if (signer && (await client.account(signer)).nonce > BigInt(tx.nonce)) return "nonce spent";
  // The mempool listing is bounded: absence from it is not proof of absence.
  return "pending or dropped";
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

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

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

  private async text(url: string, init?: RequestInit): Promise<string> {
    // Bounded: a node that stalls or streams forever cannot hang the wallet.
    const res = await this.fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new NodeError(res.status, "response too large");
    if (!res.ok) throw new NodeError(res.status, refusalOf(text));
    return text;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    return JSON.parse(await this.text(url, init)) as T;
  }

  info() {
    return this.request<ChainInfo>(this.url("/api/chain/info"));
  }
  /** Balance and nonce are UInt64: read as exact integers, never through a double. */
  async account(address: string): Promise<AccountState> {
    const text = await this.text(this.url(`/api/state/account/${encodeURIComponent(address)}`));
    const exact = JSON.parse(text.replace(/"(balance|nonce)"\s*:\s*(\d+)/g, '"$1":"$2"'));
    return { owner: exact.owner, balance: BigInt(exact.balance), nonce: BigInt(exact.nonce) };
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
