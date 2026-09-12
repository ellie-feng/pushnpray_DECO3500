// One-word, concrete-object prompts paired with a pictogram so the game
// reads the same regardless of language.
export const PROMPTS = [
  { word: "owl", emoji: "🦉" },
  { word: "watch", emoji: "⌚" },
  { word: "house", emoji: "🏠" },
  { word: "tree", emoji: "🌳" },
  { word: "fish", emoji: "🐟" },
  { word: "boat", emoji: "⛵" },
  { word: "car", emoji: "🚗" },
  { word: "key", emoji: "🔑" },
  { word: "book", emoji: "📖" },
  { word: "clock", emoji: "⏰" },
  { word: "apple", emoji: "🍎" },
  { word: "shoe", emoji: "👟" },
  { word: "ball", emoji: "⚽" },
  { word: "flower", emoji: "🌸" },
  { word: "bird", emoji: "🐦" },
  { word: "chair", emoji: "🪑" },
  { word: "spoon", emoji: "🥄" },
  { word: "umbrella", emoji: "☂️" },
  { word: "balloon", emoji: "🎈" },
  { word: "kite", emoji: "🪁" },
  { word: "ladder", emoji: "🪜" },
  { word: "bridge", emoji: "🌉" },
  { word: "cloud", emoji: "☁️" },
  { word: "heart", emoji: "❤️" },
  { word: "mushroom", emoji: "🍄" },
  { word: "crown", emoji: "👑" },
  { word: "guitar", emoji: "🎸" },
  { word: "camera", emoji: "📷" },
  { word: "lightbulb", emoji: "💡" },
  { word: "bee", emoji: "🐝" },
  { word: "snail", emoji: "🐌" },
  { word: "moon", emoji: "🌙" },
  { word: "star", emoji: "⭐" },
  { word: "sun", emoji: "☀️" },
  { word: "hat", emoji: "🎩" },
  { word: "sunglasses", emoji: "🕶️" },
  { word: "elephant", emoji: "🐘" },
  { word: "butterfly", emoji: "🦋" },
  { word: "ice cream", emoji: "🍦" },
  { word: "pizza", emoji: "🍕" },
  { word: "bicycle", emoji: "🚲" },
  { word: "airplane", emoji: "✈️" },
  { word: "rocket", emoji: "🚀" },
  { word: "cactus", emoji: "🌵" },
  { word: "candle", emoji: "🕯️" },
  { word: "hammer", emoji: "🔨" },
  { word: "bucket", emoji: "🪣" },
  { word: "teddy bear", emoji: "🧸" },
];

// Picks two different prompts so the two players never get the same word.
export function pickTwoDistinct() {
  const a = Math.floor(Math.random() * PROMPTS.length);
  let b = Math.floor(Math.random() * (PROMPTS.length - 1));
  if (b >= a) b += 1;
  return [PROMPTS[a], PROMPTS[b]];
}
