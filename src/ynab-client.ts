import { api, Configuration, MoneyMovementsApi } from "ynab";
import { apiUsageTracker } from "./utils/api-usage.js";
import { withAiFlag } from "./utils/ai-flag.js";

// Every request: rate-limit accounting, plus the AI flag on transaction writes.
const trackedFetch = withAiFlag(apiUsageTracker.wrappedFetch);

class TrackedApi extends api {
  constructor(accessToken: string) {
    super(accessToken);
    this._configuration = new Configuration({
      accessToken,
      fetchApi: trackedFetch,
    });
  }
}

let client: TrackedApi | null = null;
let moneyMovementsApi: MoneyMovementsApi | null = null;

function getToken(): string {
  const token = process.env.YNAB_API_TOKEN;
  if (!token) {
    throw new Error(
      "YNAB_API_TOKEN environment variable is required. " +
        "Generate one at: YNAB > Account Settings > Developer Settings"
    );
  }
  return token;
}

export function getClient(): api {
  if (!client) {
    client = new TrackedApi(getToken());
  }
  return client;
}

export function getMoneyMovementsClient(): MoneyMovementsApi {
  if (!moneyMovementsApi) {
    moneyMovementsApi = new MoneyMovementsApi(
      new Configuration({
        accessToken: getToken(),
        fetchApi: trackedFetch,
      })
    );
  }
  return moneyMovementsApi;
}

/**
 * Send a request the generated SDK cannot express.
 *
 * The SDK's *ToJSON serializers emit only the fields they know about, so a
 * property attached past the type is silently dropped on the way out - the
 * request succeeds and the field never reaches YNAB. Fields the live API has
 * but the pinned SDK does not (goal_frequency, added in server v1.86.0) have to
 * bypass the serializer entirely.
 *
 * Uses the same token and the same tracked fetch, so these requests count
 * against the rate limit and get the same non-JSON error handling.
 */
export async function requestUntyped<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown
): Promise<T> {
  const response = await trackedFetch(`https://api.ynab.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw json;
  return json as T;
}
