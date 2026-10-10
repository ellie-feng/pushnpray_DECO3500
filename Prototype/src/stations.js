// Each iPad is permanently dedicated to one physical spot, chosen by a URL
// parameter (e.g. index.html?station=microwave) rather than by who opens
// the link first — there's no claiming/racing involved any more. Bookmark
// or "Add to Home Screen" the right link on each device once.
export const STATIONS = {
  microwave: {
    label: "Microwave",
    icon: "🍽️",
    duetRole: "A",
    prompts: [
      "What's for lunch?",
      "What are you microwaving?",
      "Any food cravings today?",
      "Best snack right now?",
      "What smells so good?",
      "Popcorn or leftovers?",
    ],
  },
  printer: {
    label: "Printer",
    icon: "🖨️",
    duetRole: "B",
    // Asked about what people are up to in the library, not the printing
    // itself — the printer sits where people study, read, snack and play.
    prompts: [
      "What are you studying?",
      "What are you eating?",
      "What are you watching?",
      "What are you reading?",
      "What are you playing?",
      "What's on your agenda this week?",
    ],
  },
};

// Reads ?station=<id> from the current URL. Returns null if missing or
// unknown so the caller can show a setup screen instead of guessing.
export function getStationFromUrl() {
  const id = new URLSearchParams(location.search).get("station");
  if (!id || !STATIONS[id]) return null;
  return { id, ...STATIONS[id] };
}
