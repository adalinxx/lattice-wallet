// The extension popup: the shared wallet UI on the extension's platform —
// the background worker signs, chrome.storage keeps settings, and node reach
// is granted per origin.

import { startWallet } from "./app.ts";
import { walletClient } from "../lib/wallet/client.ts";
import { HOSTED_NODE_ORIGINS, originPattern } from "../lib/config.ts";
import { NodePermissionError } from "../lib/wallet/node.ts";

// The popup opens backup flows in a tab of this same page: a tab may hold the
// camera, pick files and print; a popup closes on each of those.
const view = new URLSearchParams(location.search).get("view");
const fullPage = view === "backup" || view === "restore" || view === "wallet";
if (fullPage) document.body.classList.add("page");

// Remove the old optional all-HTTPS grant on upgrade. The three exact hosted
// origins are required manifest permissions; arbitrary declarations remain optional.
if (await chrome.permissions.contains({ origins: ["https://*/*"] })) {
  await chrome.permissions.remove({ origins: ["https://*/*"] });
}
// The signer lives in the background worker, which the browser stops after
// about thirty seconds without a message, discarding the unlocked session.
// While a wallet page is in view it checks in, so the session ends at the
// signer's own idle lock instead. A status read never postpones that lock.
setInterval(() => {
  if (document.visibilityState === "visible") void chrome.runtime.sendMessage({ type: "getState" }).catch(() => {});
}, 20_000);

startWallet({
  wallet: walletClient((msg) => chrome.runtime.sendMessage(msg)),
  store: chrome.storage.local,
  requestOrigins: (origins) => chrome.permissions.request({ origins }),
  hasOrigins: (origins) => chrome.permissions.contains({ origins }),
  releaseUnusedOrigins: async (keep) => {
    const granted = await chrome.permissions.getAll();
    const unused = (granted.origins ?? []).filter((origin) => !keep.includes(origin)
      && !HOSTED_NODE_ORIGINS.some((required) => required === origin));
    if (unused.length && !await chrome.permissions.remove({ origins: unused })) throw new Error("Could not remove node permissions.");
  },
  fetch: async (url, init) => {
    const origin = originPattern(String(url));
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      const hosted = HOSTED_NODE_ORIGINS.some((required) => required === origin);
      throw new NodePermissionError(hosted
        ? "Chrome has blocked access to this hosted node. Reload the updated extension and check its site-access permissions."
        : "Node permission is missing. Choose this operator under Custom node to grant access.");
    }
    return fetch(url, init);
  },
  // The node sees this extension's requests from this origin.
  pairOrigin: location.origin,
  camera: fullPage,
  initialView: view === "backup" || view === "restore" ? view : undefined,
  openFullPage: (v) => { chrome.tabs.create({ url: chrome.runtime.getURL(`popup/index.html?view=${v}`) }); window.close(); },
});
