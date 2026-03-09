import { api, Configuration, MoneyMovementsApi } from "ynab";
import { apiUsageTracker } from "./utils/api-usage.js";

class TrackedApi extends api {
  constructor(accessToken: string) {
    super(accessToken);
    this._configuration = new Configuration({
      accessToken,
      fetchApi: apiUsageTracker.wrappedFetch,
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
        fetchApi: apiUsageTracker.wrappedFetch,
      })
    );
  }
  return moneyMovementsApi;
}
