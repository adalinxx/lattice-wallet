// The extension popup: the shared wallet UI on the extension's platform —
// the background worker signs, chrome.storage keeps settings, and node reach
// is granted per origin.

import { startWallet } from "./app.ts";
import { wallet } from "../lib/wallet/client.ts";

startWallet({
  wallet,
  store: chrome.storage.local,
  requestOrigins: (origins) => chrome.permissions.request({ origins }),
});
