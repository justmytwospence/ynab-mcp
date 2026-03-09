/** Convert dollar amount to YNAB milliunits (e.g., 25.50 -> 25500) */
export function dollarsToMilliunits(dollars: number): number {
  return Math.round(dollars * 1000);
}

/** Convert YNAB milliunits to dollar amount (e.g., 25500 -> 25.50) */
export function millunitsToDollars(milliunits: number): number {
  return milliunits / 1000;
}

/** Format milliunits as a currency string (e.g., 25500 -> "$25.50") */
export function formatCurrency(milliunits: number): string {
  const dollars = milliunits / 1000;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Format a date string for display */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "N/A";
  return dateStr;
}

/** Build a text response for MCP tool results */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Build an error response for MCP tool results */
export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
