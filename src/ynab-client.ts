import { api, Configuration, MoneyMovementsApi } from "ynab";

let client: api | null = null;
let moneyMovementsApi: MoneyMovementsApi | null = null;
let configuration: Configuration | null = null;

function getConfiguration(): Configuration {
  if (!configuration) {
    const token = process.env.YNAB_API_TOKEN;
    if (!token) {
      throw new Error(
        "YNAB_API_TOKEN environment variable is required. " +
          "Generate one at: YNAB > Account Settings > Developer Settings"
      );
    }
    configuration = new Configuration({
      accessToken: token,
    });
  }
  return configuration;
}

export function getClient(): api {
  if (!client) {
    const token = process.env.YNAB_API_TOKEN;
    if (!token) {
      throw new Error(
        "YNAB_API_TOKEN environment variable is required. " +
          "Generate one at: YNAB > Account Settings > Developer Settings"
      );
    }
    client = new api(token);
  }
  return client;
}

export function getMoneyMovementsClient(): MoneyMovementsApi {
  if (!moneyMovementsApi) {
    moneyMovementsApi = new MoneyMovementsApi(getConfiguration());
  }
  return moneyMovementsApi;
}
