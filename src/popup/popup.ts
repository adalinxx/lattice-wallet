// The extension popup: the shared wallet UI on the extension's platform —
// the background worker signs, chrome.storage keeps settings, and node reach
// is granted per origin.

import { startWallet } from "./app.ts";
import { walletClient } from "../lib/wallet/client.ts";

startWallet({
  wallet: walletClient((msg) => chrome.runtime.sendMessage(msg)),
  store: chrome.storage.local,
  requestOrigins: (origins) => chrome.permissions.request({ origins }),
});
