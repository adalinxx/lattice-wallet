// Carries `window.lattice` calls from the page to the wallet's worker and the
// answers back. It runs isolated from the page; the worker decides who is
// asking from the tab Chrome reports, not from anything the page says.

const RELAY_CHANNEL = "lattice-wallet";

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || data?.channel !== RELAY_CHANNEL || data.direction !== "to-wallet" || typeof data.id !== "string") return;
  const answer = (response: unknown) =>
    window.postMessage({ channel: RELAY_CHANNEL, direction: "to-page", id: data.id, response }, window.location.origin);
  // Asking to connect needs a click or key press the person just made. This
  // world reads the browser's own activation state, which the page cannot set.
  if (data.call?.method === "connect" && !navigator.userActivation?.isActive) {
    answer({ ok: false, error: "connect() must be called from a click or key press" });
    return;
  }
  chrome.runtime.sendMessage({ type: "provider", call: data.call })
    .then(answer)
    .catch((e) => answer({ ok: false, error: String(e?.message ?? e) }));
});
