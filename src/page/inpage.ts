// `window.lattice`, in the page's own world. It holds nothing: each call is
// posted to the wallet's content script, which asks the wallet; connecting
// and every write are approved by the person in the wallet's own window.
//
//   const address = await lattice.connect(); // from a click
//   const { transactionCID } = await lattice.writeRecords({ chainPath, actions, payments, fee });
//   const { publicKey, signature } = await lattice.signMessage({ text });
//   const { transactionCID } = await lattice.openRequest("lattice://write?v=1&intent=…"); // from a click

const CHANNEL = "lattice-wallet";
const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || data?.channel !== CHANNEL || data.direction !== "to-page") return;
  const call = waiting.get(data.id);
  if (!call) return;
  waiting.delete(data.id);
  if (data.response?.ok) call.resolve(data.response);
  else call.reject(new Error(data.response?.error ?? "The wallet did not answer"));
});

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.postMessage({ channel: CHANNEL, direction: "to-wallet", id, call: { method, params } }, window.location.origin);
  });
}

const lattice = Object.freeze({
  isLatticeWallet: true,
  /** The address this site was given, asking the person the first time. Call it from a click. */
  connect: async () => (await request("connect")).address as string,
  /** The address this site was given, or null; never asks. */
  address: async () => (await request("address")).address as string | null,
  /** Forget this site. */
  disconnect: async () => { await request("disconnect"); },
  /**
   * Write records on one chain, and pay addresses from the connected account
   * in the same transaction, once the person approves: the wallet signs and sends it.
   */
  writeRecords: async (params: {
    chainPath: string[];
    actions: { key: string; oldValue?: string; newValue?: string }[];
    payments?: { to: string; amount: string }[];
    fee: string;
  }) => ({ transactionCID: (await request("writeRecords", params)).transactionCID as string }),
  /**
   * Hand the wallet a lattice://write request, to sign as whichever account
   * the person chooses in its window. Needs no connect(); call it from a click.
   */
  openRequest: async (uri: string) => ({ transactionCID: (await request("openRequest", { uri })).transactionCID as string }),
  /** Sign `text`, once the person approves. The signed bytes are "lattice-message:" + this origin + "\n" + text. */
  signMessage: async (params: { text: string }) => {
    const { publicKey, signature } = await request("signMessage", params);
    return { publicKey: publicKey as string, signature: signature as string };
  },
});

Object.defineProperty(window, "lattice", { value: lattice, configurable: false, writable: false });
window.dispatchEvent(new Event("lattice#initialized"));
