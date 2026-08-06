import type { CurrencyFormat } from "ynab";
import { apiUsageTracker } from "./api-usage.js";
import { describeError } from "./errors.js";

const RATE_LIMIT_WARN_THRESHOLD = 50;
const RATE_LIMIT_CRITICAL_THRESHOLD = 20;

/**
 * Convert a currency amount to YNAB milliunits (e.g., 25.50 -> 25500).
 *
 * Milliunits are always thousandths of the currency unit, whatever the
 * currency's decimal digits: 100 JPY is 100000 milliunits just as 100 USD is.
 * The scale is not an assumption about two decimal places.
 */
export function dollarsToMilliunits(dollars: number): number {
  return Math.round(dollars * 1000);
}

/** Convert YNAB milliunits to a currency amount (e.g., 25500 -> 25.50) */
export function milliunitsToAmount(milliunits: number): number {
  return milliunits / 1000;
}

/**
 * The budget's currency format, once something has read it.
 *
 * The full export returns the *Base models, which carry no server-formatted
 * `_formatted` fields, so amounts must be formatted here from the budget's
 * CurrencyFormat. get_budget_settings and the snapshot layer both register it.
 * Until one of them runs there is nothing to go on, so formatting falls back to
 * USD/en-US - wrong for a JPY budget, but only until the first budget read.
 *
 * This is a single active format rather than a per-budget registry: every tool
 * would otherwise have to thread budget_id into every formatting call, and a
 * server holding one personal access token is working in one budget at a time.
 */
let activeCurrencyFormat: CurrencyFormat | undefined;

export function setActiveCurrencyFormat(format: CurrencyFormat | undefined | null) {
  if (format) activeCurrencyFormat = format;
}

/** Format milliunits using the budget's currency format (e.g., 25500 -> "$25.50") */
export function formatCurrency(milliunits: number, format = activeCurrencyFormat): string {
  const amount = milliunits / 1000;
  if (!format) {
    return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  const digits = format.decimal_digits;
  const negative = amount < 0;
  const fixed = Math.abs(amount).toFixed(digits);
  const [whole = "0", fraction = ""] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.group_separator);
  const number = digits > 0 ? `${grouped}${format.decimal_separator}${fraction}` : grouped;

  const symbol = format.display_symbol ? format.currency_symbol : "";
  const body = format.symbol_first ? `${symbol}${number}` : `${number}${symbol}`;
  return negative ? `-${body}` : body;
}

/**
 * Render the hidden/internal/deleted state of a category or category group as
 * a display suffix, e.g. " [hidden]". Empty when the entity is ordinary.
 */
export function attributes(entity: { hidden?: boolean; internal?: boolean; deleted?: boolean }): string {
  const flags = [
    entity.internal ? "internal" : null,
    entity.hidden ? "hidden" : null,
    entity.deleted ? "deleted" : null,
  ].filter(Boolean);
  return flags.length > 0 ? ` [${flags.join(", ")}]` : "";
}

/** Format a date string for display */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "N/A";
  return dateStr;
}

function rateLimitFooter(): string {
  const usage = apiUsageTracker.getUsage();
  if (usage.remaining > RATE_LIMIT_WARN_THRESHOLD) return "";

  const reset = usage.windowResetsAt
    ? ` Window resets at ${usage.windowResetsAt}.`
    : "";

  if (usage.remaining === 0) {
    return `\n\n[RATE LIMIT REACHED] 0/${usage.limit} calls remaining this hour.${reset} Further requests will fail with 429 until the window slides.`;
  }
  if (usage.remaining < RATE_LIMIT_CRITICAL_THRESHOLD) {
    return `\n\n[RATE LIMIT CRITICAL] ${usage.remaining}/${usage.limit} calls remaining this hour.${reset} Pause non-essential calls.`;
  }
  return `\n\n[RATE LIMIT WARNING] ${usage.remaining}/${usage.limit} calls remaining this hour.${reset}`;
}

/** Build a text response for MCP tool results */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text: text + rateLimitFooter() }] };
}

/** Build an error response for MCP tool results */
export function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${describeError(error)}${rateLimitFooter()}` }],
    isError: true,
  };
}
