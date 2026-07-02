import { TokenUsage } from "./types";

// USD per 1M tokens. Best-effort defaults; cost is an estimate only.
// Matched by substring against the model id (e.g. "claude-opus-4-8").
interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Array<{ match: string; price: ModelPrice }> = [
  { match: "opus", price: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: "sonnet", price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: "haiku", price: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 } },
  { match: "fable", price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
];

const DEFAULT_PRICE: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

function priceFor(model: string): ModelPrice {
  const lower = model.toLowerCase();
  for (const p of PRICES) {
    if (lower.includes(p.match)) {
      return p.price;
    }
  }
  return DEFAULT_PRICE;
}

// Estimate cost from total token usage. Uses the first/primary model for rate
// selection; good enough for a relative-cost dashboard.
export function estimateCost(tokens: TokenUsage, models: string[]): number {
  const price = priceFor(models[0] ?? "");
  const m = 1_000_000;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheCreationInputTokens * price.cacheWrite +
      tokens.cacheReadInputTokens * price.cacheRead) /
    m
  );
}
