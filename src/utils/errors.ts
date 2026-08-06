/**
 * YNAB error handling.
 *
 * The generated SDK does not throw an Error on a failed request: its runtime
 * does `throw await response.json()`, so what reaches a catch block is the bare
 * response body `{ error: { id, name, detail } }`, which has no `message`.
 * Reading `e.message` off it yields undefined.
 */
export interface YnabApiError {
  error: { id: string; name: string; detail: string };
}

export function isYnabApiError(e: unknown): e is YnabApiError {
  if (typeof e !== "object" || e === null) return false;
  const error = (e as YnabApiError).error;
  return typeof error === "object" && error !== null && typeof error.id === "string";
}

/** The error id YNAB returned, e.g. "503" or "403.4". */
export function errorId(e: unknown): string | null {
  return isYnabApiError(e) ? e.error.id : null;
}

/** HTTP status of a YNAB error, taken from the leading digits of its id. */
export function errorStatus(e: unknown): number | null {
  const id = errorId(e);
  if (!id) return null;
  const status = Number.parseInt(id.split(".")[0]!, 10);
  return Number.isNaN(status) ? null : status;
}

/**
 * 403.4 data_limit_reached. Undocumented and unquantified, distinct from a
 * rate limit, and not worth retrying.
 */
export function isDataLimitReached(e: unknown): boolean {
  return errorId(e) === "403.4";
}

/** Render any thrown value as a message worth showing the user. */
export function describeError(e: unknown): string {
  if (isYnabApiError(e)) {
    const { id, name, detail } = e.error;
    if (id === "429") {
      return `${detail} (${name}, ${id}). The 200 requests/hour limit is per access token and is shared with ` +
        `the YNAB app; check get_api_usage.`;
    }
    if (isDataLimitReached(e)) {
      return `${detail} (${name}, ${id}). This is a data limit, not a rate limit - retrying will not help.`;
    }
    return `${detail} (${name}, ${id})`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
