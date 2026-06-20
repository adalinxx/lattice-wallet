// Background service worker. In the target architecture this is the SOLE signer:
// it holds the decrypted secret in memory while unlocked, derives accounts, and
// signs transactions on request from the popup — the popup never sees raw keys.
//
// v0 stub: establishes the idle auto-lock alarm and the message channel. The
// keystore + signing handlers land next (tasks: keystore, signer). The popup
// currently runs crypto in-page for the receive/balance slice.

const AUTO_LOCK_MINUTES = 10;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("auto-lock", { periodInMinutes: AUTO_LOCK_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-lock") {
    // Will zero the in-memory unlocked secret once the keystore lands.
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
  }
  return false;
});

export {};
