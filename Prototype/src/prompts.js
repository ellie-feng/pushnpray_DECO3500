// One shared scene per round, not two secret words — both players see it
// from the very start (onboarding shows it plainly) and draw it together,
// rather than each secretly drawing their own answer to reveal at the end.
export const PROMPTS = [
  { word: "Snail on a train", emoji: "🐌" },
  { word: "Owl in a tree", emoji: "🦉" },
  { word: "Octopus at a birthday party", emoji: "🐙" },
  { word: "Shark riding a bicycle", emoji: "🦈" },
  { word: "Penguin at the beach", emoji: "🐧" },
  { word: "Mermaid at a rock concert", emoji: "🧜" },
  { word: "Snowman in a desert", emoji: "⛄" },
  { word: "Turtle winning a race", emoji: "🐢" },
];

export function pickOne() {
  return PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
}
