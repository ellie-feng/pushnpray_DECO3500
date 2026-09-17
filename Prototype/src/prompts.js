// Each player draws their answer to a short personal question rather than
// a single noun — more expressive, and it matches the question-style
// prompts already used on the message board. Paired with a pictogram so
// the theme reads even before you can read the words.
export const PROMPTS = [
  { word: "What's your favourite movie?", emoji: "🎬" },
  { word: "What's your dream holiday?", emoji: "✈️" },
  { word: "What's your favourite food?", emoji: "🍕" },
  { word: "What's your happy place?", emoji: "🌴" },
  { word: "What's your favourite animal?", emoji: "🐾" },
  { word: "What's your favourite season?", emoji: "🍂" },
  { word: "What's your ultimate comfort food?", emoji: "🍜" },
  { word: "What's your ideal weekend?", emoji: "🛋️" },
  { word: "What's your favourite hobby?", emoji: "🎨" },
  { word: "What's your favourite sport?", emoji: "⚽" },
  { word: "What's your go-to drink?", emoji: "🧋" },
  { word: "What's your dream job?", emoji: "💼" },
  { word: "What's a song stuck in your head?", emoji: "🎵" },
  { word: "What's your favourite book?", emoji: "📚" },
  { word: "What superpower would you want?", emoji: "🦸" },
  { word: "What's your favourite place on Earth?", emoji: "🗺️" },
  { word: "What's your go-to snack?", emoji: "🍿" },
  { word: "What's your favourite game?", emoji: "🎮" },
  { word: "What's your favourite childhood memory?", emoji: "🧸" },
  { word: "What's on your bucket list?", emoji: "🪣" },
];

// Picks two different prompts so the two players never get the same question.
export function pickTwoDistinct() {
  const a = Math.floor(Math.random() * PROMPTS.length);
  let b = Math.floor(Math.random() * (PROMPTS.length - 1));
  if (b >= a) b += 1;
  return [PROMPTS[a], PROMPTS[b]];
}
