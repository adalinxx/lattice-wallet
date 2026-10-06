// The extension popup: the shared wallet UI on the extension's platform —
// the background worker signs, chrome.storage keeps settings, and node reach
// is granted per origin.

import { startWallet } from "./app.ts";
import { walletClient } from "../lib/wallet/client.ts";

// The popup opens backup flows in a tab of this same page: a tab may hold the
// camera, pick files and print; a popup closes on each of those.
const view = new URLSearchParams(location.search).get("view");
const fullPage = view === "backup" || view === "restore" || view === "wallet";
if (fullPage) document.body.classList.add("page");

startWallet({
  wallet: walletClient((msg) => chrome.runtime.sendMessage(msg)),
  store: chrome.storage.local,
  requestOrigins: (origins) => chrome.permissions.request({ origins }),
  hasOrigins: (origins) => chrome.permissions.contains({ origins }),
  // The node sees this extension's requests from this origin.
  pairOrigin: location.origin,
  camera: fullPage,
  initialView: view === "backup" || view === "restore" ? view : undefined,
  openFullPage: (v) => { chrome.tabs.create({ url: chrome.runtime.getURL(`popup/index.html?view=${v}`) }); window.close(); },
});
