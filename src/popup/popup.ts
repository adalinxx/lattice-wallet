// The extension popup: the shared wallet UI on the extension's platform —
// the background worker signs, chrome.storage keeps settings, and node reach
// is granted per origin.

import { startWallet } from "./app.ts";
import { walletClient } from "../lib/wallet/client.ts";
import { CHROME_SITE_ACCESS_HELP, HOSTED_NODE_ORIGINS, originPattern } from "../lib/config.ts";
import { NodePermissionError } from "../lib/wallet/node.ts";

// The popup opens backup flows in a tab of this same page: a tab may hold the
// camera, pick files and print; a popup closes on each of those.
const view = new URLSearchParams(location.search).get("view");
const fullPage = view === "backup" || view === "restore" || view === "wallet";
if (fullPage) document.body.classList.add("page");

// The exact hosted origins are required manifest permissions; reaching
// any other HTTPS node is the optional grant automatic discovery asks for.
startWallet({
  wallet: walletClient((msg) => chrome.runtime.sendMessage(msg)),
  store: chrome.storage.local,
  requestOrigins: (origins) => chrome.permissions.request({ origins }),
  hasOrigins: (origins) => chrome.permissions.contains({ origins }),
  // Chrome treats node origins covered by static content scripts as required.
  // permissions.remove() rejects them, even when also declared optional.
  siteAccessHelp: CHROME_SITE_ACCESS_HELP,
  fetch: async (url, init) => {
    const origin = originPattern(String(url));
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      const hosted = HOSTED_NODE_ORIGINS.some((required) => required === origin);
      throw new NodePermissionError(hosted
        ? "Chrome has blocked access to this hosted node. Reload the updated extension and check its site-access permissions."
        : "Node permission is missing. Find a node automatically, or choose this operator under Custom node, to grant access.");
    }
    return fetch(url, init);
  },
  // The worker says when its idle alarm locks it; a worker the browser stopped
  // says nothing, so the page also checks in.
  onLocked: (tell) => chrome.runtime.onMessage.addListener((msg: { type?: string }, sender) => {
    if (sender.id === chrome.runtime.id && msg?.type === "locked") tell();
  }),
  signerCanStop: true,
  // The node sees this extension's requests from this origin.
  pairOrigin: location.origin,
  camera: fullPage,
  initialView: view === "backup" || view === "restore" ? view : undefined,
  openFullPage: (v) => { chrome.tabs.create({ url: chrome.runtime.getURL(`popup/index.html?view=${v}`) }); window.close(); },
});
