// Relays requests from the content script to the local backend.
// (Fetching from here avoids CORS/CSP issues on linkedin.com.)
const BACKEND = "http://localhost:8000";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "draft") return;
  fetch(`${BACKEND}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return r.json();
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: String(e).includes("Failed to fetch")
          ? "Can't reach the backend. Is uvicorn running on port 8000?"
          : String(e),
      })
    );
  return true; // keep the channel open for the async response
});
