/**
 * Mark the transactions this server changes with a flag, so a person can see
 * and filter what an AI touched (YNAB: name the flag "AI" in the app, then
 * filter by it).
 *
 * Applied as a fetch wrapper, beneath the SDK and every tool and workflow, so
 * no write path can forget it. Enabled by YNAB_MCP_AI_FLAG=<color>; unset or
 * "off" disables it.
 *
 * Rules:
 * - Only meaningful edits are marked: creates, and updates that change the
 *   account, date, amount, payee, category, memo or splits. Bookkeeping
 *   (cleared, approved, reconciled) is not, so reconciling an account does not
 *   flag every row in it.
 * - A flag the caller sets explicitly (including null, which clears) wins.
 * - A flag already on a transaction is kept: updates go out unchanged, and only
 *   transactions that come back unflagged get the AI flag, in one follow-up
 *   bulk request (one extra API call per write that needs it).
 * - Bank imports and scheduled transactions are left alone.
 */

export const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

const MEANINGFUL_FIELDS = [
  "account_id",
  "date",
  "amount",
  "payee_id",
  "payee_name",
  "category_id",
  "memo",
  "subtransactions",
] as const;

// /plans/{id}/transactions or /plans/{id}/transactions/{transaction_id};
// "budgets" is the API's older spelling of "plans".
const TRANSACTIONS_PATH = /\/(?:plans|budgets)\/[^/]+\/transactions(?:\/([^/?#]+))?\/?(?:[?#]|$)/;

type Item = Record<string, unknown>;

export function aiFlagColor(env: NodeJS.ProcessEnv = process.env): FlagColor | null {
  const raw = env.YNAB_MCP_AI_FLAG?.trim().toLowerCase();
  if (!raw || raw === "off" || raw === "none" || raw === "false") return null;
  if ((FLAG_COLORS as readonly string[]).includes(raw)) return raw as FlagColor;
  console.error(`YNAB_MCP_AI_FLAG=${raw} is not a YNAB flag color (${FLAG_COLORS.join(", ")}); AI flagging is off`);
  return null;
}

function isMeaningful(item: Item): boolean {
  return MEANINGFUL_FIELDS.some((f) => item[f] !== undefined);
}

function wantsMark(item: Item): boolean {
  return !("flag_color" in item) && isMeaningful(item);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseBody(init: RequestInit | undefined): Item | null {
  if (typeof init?.body !== "string") return null;
  try {
    const body = JSON.parse(init.body);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function rebuild(response: Response, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function withAiFlag(inner: typeof fetch, color: FlagColor | null = aiFlagColor()): typeof fetch {
  if (!color) return inner;

  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = urlOf(input);
    const match = TRANSACTIONS_PATH.exec(url);
    if (!match || !["POST", "PUT", "PATCH"].includes(method)) return inner(input, init);
    const segment = match[1];
    const body = parseBody(init);
    if (!body) return inner(input, init);

    // Create: a new transaction has no flag to keep, so set it in the request.
    if (method === "POST" && segment === undefined) {
      const items = [body.transaction, ...((body.transactions as unknown[]) ?? [])].filter(
        (t): t is Item => !!t && typeof t === "object"
      );
      for (const t of items) if (!("flag_color" in t)) t.flag_color = color;
      return inner(input, { ...init, body: JSON.stringify(body) });
    }

    // Update: send as asked, then flag what came back unflagged.
    const isSingle = method === "PUT" && segment !== undefined && segment !== "import";
    const isBulk = method === "PATCH" && segment === undefined;
    if (!isSingle && !isBulk) return inner(input, init);

    const requested = (isSingle ? [body.transaction] : ((body.transactions as unknown[]) ?? [])).filter(
      (t): t is Item => !!t && typeof t === "object"
    );
    const marked = requested.filter(wantsMark);
    const response = await inner(input, init);
    if (!response.ok || marked.length === 0) return response;

    let json: any;
    try {
      json = await response.clone().json();
    } catch {
      return response;
    }
    const returned: Item[] = isSingle
      ? [json?.data?.transaction].filter(Boolean)
      : json?.data?.transactions ?? [];
    const targets = returned.filter((t) => {
      if (t.flag_color) return false;
      return marked.some((m) =>
        isSingle ||
        (m.id !== undefined && m.id === t.id) ||
        (m.import_id !== undefined && m.import_id === t.import_id)
      );
    });
    if (targets.length === 0) return response;

    const bulkUrl = new URL(url);
    bulkUrl.pathname = bulkUrl.pathname.replace(/\/transactions(?:\/[^/]+)?\/?$/, "/transactions");
    bulkUrl.search = "";
    try {
      const flagResponse = await inner(bulkUrl, {
        method: "PATCH",
        headers: init?.headers,
        body: JSON.stringify({ transactions: targets.map((t) => ({ id: t.id, flag_color: color })) }),
      });
      if (!flagResponse.ok) {
        console.error(`AI flag: marking ${targets.length} transaction(s) failed with HTTP ${flagResponse.status}`);
        return response;
      }
    } catch (e) {
      console.error(`AI flag: marking ${targets.length} transaction(s) failed: ${e}`);
      return response;
    }
    for (const t of targets) t.flag_color = color;
    return rebuild(response, json);
  };
}
