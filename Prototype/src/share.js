// Viewer for a shared copy of a finished duet drawing — the page the QR code
// on the finish screen opens on someone's phone. Read-only: it looks up one
// share by the id in the URL and shows the image with a way to save it.
import { fetchShare } from "./realtime.js";

const els = {
  title: document.getElementById("title"),
  sub: document.getElementById("sub"),
  state: document.getElementById("state"),
  img: document.getElementById("img"),
  save: document.getElementById("save"),
  hint: document.getElementById("hint"),
};

// Only ever render what this app itself writes: a JPEG data URL. Shares are
// publicly writable (once), so anything else — an external URL, a script URL —
// is refused rather than handed to an <img>.
const IMG_PREFIX = "data:image/jpeg;base64,";

function fail(message) {
  els.state.textContent = message;
}

async function main() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return fail("This link is missing its drawing id.");

  let share;
  try {
    share = await fetchShare(id);
  } catch {
    return fail("Couldn't load your drawing — check your connection and try again.");
  }
  if (!share || typeof share.img !== "string" || !share.img.startsWith(IMG_PREFIX)) {
    return fail("We couldn't find that drawing. The link may be wrong or the copy may have expired.");
  }

  if (typeof share.prompt === "string" && share.prompt) {
    els.title.textContent = `${share.emoji ? share.emoji + " " : ""}${share.prompt}`;
  }
  els.img.src = share.img;
  els.img.hidden = false;
  els.state.hidden = true;

  // A blob URL makes the download button save a real file; a plain data URL
  // is rejected by some mobile browsers for downloads.
  try {
    const blob = await (await fetch(share.img)).blob();
    els.save.href = URL.createObjectURL(blob);
    els.save.download = "pushnpray-drawing.jpg";
    els.save.hidden = false;
  } catch {
    /* the press-and-hold hint below still works */
  }
  els.hint.hidden = false;
}

main();
