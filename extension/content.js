// LinkedIn Note Drafter — content script
//
// Flow on a profile page (linkedin.com/in/...):
//   F2 (1st press) -> reads the profile, asks the backend for a note, shows it
//   F2 (2nd press) -> opens Connect > Add a note and pastes the note in
//   You review and click Send yourself. This script never clicks Send.

const HOTKEY = "F2";
const MAX_CHARS = 300;

let state = { url: null, busy: false };
let panel = null; // { host, root, textarea, status, count }

// ---------- hotkey ----------

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== HOTKEY || e.repeat) return;
    const inOurPanel = panel && e.composedPath().includes(panel.host);
    if (!inOurPanel && isTypingTarget(e.target)) return;
    if (!location.pathname.startsWith("/in/")) return;

    e.preventDefault();
    e.stopPropagation();
    if (state.busy) return;

    const url = profileUrl();
    const hasDraft = panel && panel.textarea.value.trim() && state.url === url;
    hasDraft ? insertNote() : makeDraft();
  },
  true
);

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function profileUrl() {
  // Normalize to https://www.linkedin.com/in/<slug>
  return location.origin + location.pathname.split("/").slice(0, 3).join("/");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- step 1: read the profile ----------

async function loadWholeProfile() {
  // LinkedIn lazy-loads sections below the fold; scroll down to trigger them.
  const startY = window.scrollY;
  for (let i = 0; i < 6; i++) {
    window.scrollBy(0, window.innerHeight);
    await sleep(350);
  }
  window.scrollTo(0, startY);

  // Expand truncated "…see more" text (About section, job descriptions).
  const main = document.querySelector("main");
  if (!main) return;
  main.querySelectorAll("button").forEach((b) => {
    const t = (b.innerText || "").trim().toLowerCase();
    if ((t === "…see more" || t === "...see more" || t === "see more") &&
        b.getAttribute("aria-expanded") !== "true") {
      b.click();
    }
  });
  await sleep(300);
}

function extractProfile() {
  const main = document.querySelector("main") || document.body;
  const name = (main.querySelector("h1")?.innerText || "").trim();
  const text = main.innerText.replace(/\n{3,}/g, "\n\n").trim();
  return { url: profileUrl(), name, profile_text: text.slice(0, 15000) };
}

async function makeDraft() {
  state.busy = true;
  showPanel();
  setStatus("Reading profile…");
  panel.textarea.value = "";
  updateCount();

  try {
    await loadWholeProfile();
    const payload = extractProfile();
    setStatus(`Drafting a note for ${payload.name || "this person"}…`);

    const res = await chrome.runtime.sendMessage({ type: "draft", payload });
    if (!res?.ok) throw new Error(res?.error || "Unknown error");

    state.url = payload.url;
    panel.textarea.value = res.data.draft;
    updateCount();
    setStatus(`Edit if needed, then press ${HOTKEY} to paste into the Connect note.`);
  } catch (err) {
    setStatus("Error: " + err.message, true);
  } finally {
    state.busy = false;
  }
}

// ---------- step 2: paste into the Connect dialog ----------

// LinkedIn renders some dialogs inside shadow DOM, so search through it too.
function deepQueryAll(selector, root = document) {
  const out = [...root.querySelectorAll(selector)];
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot && el !== panel?.host) {
      out.push(...deepQueryAll(selector, el.shadowRoot));
    }
  });
  return out;
}

const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

function findButton(regex, root = document) {
  return deepQueryAll('button, [role="button"], [role="menuitem"]', root).find((b) => {
    if (!isVisible(b)) return false;
    const label = b.getAttribute("aria-label") || "";
    const text = (b.innerText || "").trim();
    return regex.test(label) || regex.test(text);
  });
}

function findNoteBox() {
  return deepQueryAll('textarea[name="message"], textarea#custom-message, textarea')
    .find((t) => isVisible(t) && !panel?.root.contains(t));
}

async function waitFor(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(150);
  }
  return null;
}

async function openConnectDialog() {
  // The top card is the first <section> in <main>. Search there so we don't
  // hit "Connect" buttons in "People you may know" lists.
  const topCard = document.querySelector("main section") || document.querySelector("main");
  if (!topCard) return "notfound";

  if (findButton(/^pending$|withdraw/i, topCard)) return "pending";

  let btn = findButton(/invite .* to connect|^connect$/i, topCard);
  if (!btn) {
    // Often hidden under the "More" menu.
    const more = findButton(/^more actions$|^more$/i, topCard);
    if (!more) return "notfound";
    more.click();
    btn = await waitFor(() => findButton(/invite .* to connect|^connect$/i), 2000);
    if (!btn) return "notfound";
  }
  btn.click();
  return "opened";
}

function setNativeValue(el, value) {
  // Use the native setter + input event so LinkedIn's React state updates.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  el.focus();
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function copyFallback(text, reason) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${reason} Note copied to clipboard. Paste it manually.`, true);
  } catch {
    setStatus(`${reason} Copy the note from the box manually.`, true);
  }
}

async function insertNote() {
  const text = panel.textarea.value.trim();
  if (text.length > MAX_CHARS) {
    setStatus(`Note is ${text.length} chars. Trim it to ${MAX_CHARS} first.`, true);
    return;
  }

  state.busy = true;
  try {
    let box = findNoteBox();
    if (!box) {
      setStatus("Opening Connect…");
      const result = await openConnectDialog();
      if (result === "pending") return setStatus("Invite already pending for this person.", true);
      if (result !== "opened") return copyFallback(text, "Couldn't find the Connect button.");

      const addNote = await waitFor(() => findButton(/add a note/i), 4000);
      if (addNote) addNote.click();
      box = await waitFor(findNoteBox, 4000);
    }
    if (!box) return copyFallback(text, "Couldn't find the note box.");

    setNativeValue(box, text);
    setStatus("Pasted. Review it and click Send yourself.");
  } catch (err) {
    setStatus("Error: " + err.message, true);
  } finally {
    state.busy = false;
  }
}

// ---------- panel UI (shadow DOM so LinkedIn's CSS can't break it) ----------

function showPanel() {
  if (panel) {
    panel.host.style.display = "block";
    return;
  }
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .box { width: 340px; background: #fff; color: #1d1d1f; border-radius: 12px;
             box-shadow: 0 8px 30px rgba(0,0,0,.25); padding: 12px;
             font: 13px/1.4 -apple-system, system-ui, sans-serif; }
      .head { display:flex; justify-content:space-between; font-weight:600; margin-bottom:8px; }
      textarea { width:100%; box-sizing:border-box; height:130px; resize:vertical;
                 border:1px solid #ccc; border-radius:8px; padding:8px; font:inherit; }
      .row { display:flex; justify-content:space-between; align-items:center; margin-top:6px; }
      .count.over { color:#c00; font-weight:600; }
      .status { margin-top:6px; color:#555; min-height:18px; }
      .status.err { color:#c00; }
      button { border:0; border-radius:6px; padding:5px 10px; cursor:pointer;
               background:#0a66c2; color:#fff; font:inherit; }
      button.ghost { background:#eee; color:#333; }
      .x { background:none; color:#888; padding:0 4px; font-size:16px; }
    </style>
    <div class="box">
      <div class="head"><span>Connection note</span><button class="x" title="Close">×</button></div>
      <textarea spellcheck="true"></textarea>
      <div class="row">
        <span class="count"></span>
        <span>
          <button class="ghost regen">Regenerate</button>
          <button class="insert">Paste (${HOTKEY})</button>
        </span>
      </div>
      <div class="status"></div>
    </div>`;
  document.body.appendChild(host);

  panel = {
    host,
    root,
    textarea: root.querySelector("textarea"),
    status: root.querySelector(".status"),
    count: root.querySelector(".count"),
  };
  panel.textarea.addEventListener("input", updateCount);
  root.querySelector(".x").onclick = () => (host.style.display = "none");
  root.querySelector(".regen").onclick = () => !state.busy && makeDraft();
  root.querySelector(".insert").onclick = () => !state.busy && insertNote();
}

function updateCount() {
  const n = panel.textarea.value.length;
  panel.count.textContent = `${n}/${MAX_CHARS}`;
  panel.count.classList.toggle("over", n > MAX_CHARS);
}

function setStatus(msg, isError = false) {
  panel.status.textContent = msg;
  panel.status.classList.toggle("err", isError);
}

// Reset when LinkedIn's single-page navigation moves to a different profile.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    if (panel && profileUrl() !== state.url) {
      panel.textarea.value = "";
      updateCount();
      setStatus(`Press ${HOTKEY} to draft a note for this profile.`);
    }
  }
}, 500);
