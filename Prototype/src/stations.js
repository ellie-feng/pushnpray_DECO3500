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
    prompts: [
      "What are you printing?",
      "Urgent or can it wait?",
      "Any printer jams today?",
      "What's due today?",
      "Colour or black & white?",
      "Stapled or loose?",
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
