import type { AccountBase, CategoryBase, PlanDetail, TransactionSummaryBase } from "ynab";
import { getClient } from "./ynab-client.js";
import { errorStatus } from "./utils/errors.js";
import { setActiveCurrencyFormat } from "./utils/formatting.js";

/**
 * A cached full budget export.
 *
 * GET /v1/budgets/{id} returns every entity in the budget in a single request,
 * including `months[].categories` - the per-month, per-category budgeted /
 * activity / balance figures. Historical analysis that would otherwise cost one
 * get_month call per month costs one call in total, and subsequent refreshes
 * cost one delta call.
 */
export interface BudgetSnapshot {
  /** The budget's real id (never the "last-used" alias). */
  budgetId: string;
  plan: PlanDetail;
  /**
   * The knowledge value GET /plans/{id} returned, and only that endpoint's.
   * The counter is per-plan and monotonic, but the value an endpoint returns
   * reflects only the entity types that endpoint covers, so this must never be
   * passed to getAccounts, getCategories, or any other delta-capable call.
   */
  serverKnowledge: number;
  fetchedAt: number;
  /** True when the export was assembled per-resource after a full export timed out. */
  assembledPiecewise: boolean;
}

export interface SnapshotResult {
  snapshot: BudgetSnapshot;
  /** API calls this request spent (0 when served from cache). */
  apiCalls: number;
  /** True when a delta refresh was rejected and a full export was refetched. */
  refetchedInFull: boolean;
}

/** Keyed by the id the caller passed, so "last-used" is cached too. */
const cache = new Map<string, BudgetSnapshot>();

interface Identified {
  id: string;
  deleted?: boolean;
}

/**
 * Apply a delta list onto a cached list: changed entities replace their
 * previous version, new entities are appended, and tombstones are removed.
 */
/**
 * A full response omits deleted entities entirely; a delta response includes
 * them with deleted: true. Honoring the tombstone is what keeps a long-lived
 * cached snapshot from accumulating entities the user has since deleted.
 */
function mergeById<T extends Identified>(existing: T[] | undefined, incoming: T[] | undefined): T[] {
  const merged = new Map<string, T>((existing ?? []).map((e) => [e.id, e]));
  for (const entity of incoming ?? []) {
    if (entity.deleted) merged.delete(entity.id);
    else merged.set(entity.id, entity);
  }
  return Array.from(merged.values());
}

type MonthEntry = NonNullable<PlanDetail["months"]>[number];

function mergeMonths(existing: MonthEntry[] | undefined, incoming: MonthEntry[] | undefined): MonthEntry[] {
  const merged = new Map<string, MonthEntry>((existing ?? []).map((m) => [m.month, m]));
  for (const month of incoming ?? []) {
    if (month.deleted) {
      merged.delete(month.month);
      continue;
    }
    const previous = merged.get(month.month);
    merged.set(month.month, {
      ...month,
      // A delta month carries only the categories that changed; keep the rest.
      categories: mergeById(previous?.categories, month.categories),
    });
  }
  return Array.from(merged.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function mergePlan(existing: PlanDetail, delta: PlanDetail): PlanDetail {
  return {
    ...existing,
    ...delta,
    accounts: mergeById(existing.accounts, delta.accounts),
    payees: mergeById(existing.payees, delta.payees),
    payee_locations: mergeById(existing.payee_locations, delta.payee_locations),
    category_groups: mergeById(existing.category_groups, delta.category_groups),
    categories: mergeById(existing.categories, delta.categories),
    months: mergeMonths(existing.months, delta.months),
    transactions: mergeById(existing.transactions, delta.transactions),
    subtransactions: mergeById(existing.subtransactions, delta.subtransactions),
    scheduled_transactions: mergeById(existing.scheduled_transactions, delta.scheduled_transactions),
    scheduled_subtransactions: mergeById(
      existing.scheduled_subtransactions,
      delta.scheduled_subtransactions
    ),
  };
}

/**
 * Whether a delta response is safe to merge.
 *
 * The docs do not guarantee that a delta carries per-month category rows, and
 * this has not been confirmed empirically against a live budget. If a delta
 * reports changed months without category detail, merging it would leave the
 * cached months silently stale, so treat it as unusable and refetch in full.
 */
function deltaIsMergeable(delta: PlanDetail): boolean {
  return (delta.months ?? []).every((m) => m.deleted || Array.isArray(m.categories));
}

export interface GetSnapshotOptions {
  /**
   * Serve the cached snapshot without contacting the API when it is younger
   * than this. Default 0: always spend one delta request so the data is fresh.
   */
  maxAgeMs?: number;
  /** Ignore the cache entirely and refetch the full export. */
  forceFull?: boolean;
}

/**
 * Fetch a budget snapshot, refreshing a cached one by delta where possible.
 *
 * Costs 1 API call for a cold fetch or a delta refresh, 0 when served from
 * cache, and 2 when a delta turns out not to be mergeable.
 */
export async function getBudgetSnapshot(
  budgetId: string,
  options: GetSnapshotOptions = {}
): Promise<SnapshotResult> {
  const { maxAgeMs = 0, forceFull = false } = options;
  const cached = forceFull ? undefined : cache.get(budgetId);

  if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) {
    return { snapshot: cached, apiCalls: 0, refetchedInFull: false };
  }

  let apiCalls = 0;
  let refetchedInFull = false;

  if (cached) {
    const response = await getClient().plans.getPlanById(budgetId, cached.serverKnowledge);
    apiCalls += 1;
    if (deltaIsMergeable(response.data.plan)) {
      const snapshot: BudgetSnapshot = {
        budgetId: response.data.plan.id,
        plan: mergePlan(cached.plan, response.data.plan),
        serverKnowledge: response.data.server_knowledge ?? cached.serverKnowledge,
        fetchedAt: Date.now(),
        assembledPiecewise: cached.assembledPiecewise,
      };
      store(budgetId, snapshot);
      return { snapshot, apiCalls, refetchedInFull };
    }
    refetchedInFull = true;
  }

  try {
    const response = await getClient().plans.getPlanById(budgetId);
    apiCalls += 1;
    const snapshot: BudgetSnapshot = {
      budgetId: response.data.plan.id,
      plan: response.data.plan,
      serverKnowledge: response.data.server_knowledge ?? 0,
      fetchedAt: Date.now(),
      assembledPiecewise: false,
    };
    store(budgetId, snapshot);
    return { snapshot, apiCalls, refetchedInFull };
  } catch (e: unknown) {
    apiCalls += 1;
    if (errorStatus(e) !== 503) throw e;
    // The API has no pagination and gives up after 30 seconds of server
    // processing, so a large, long-lived budget can never complete a full
    // export. Retrying the same request would fail the same way; assemble the
    // same shape from the per-resource endpoints instead.
    const assembled = await assemblePiecewise(budgetId);
    store(budgetId, assembled.snapshot);
    return {
      snapshot: assembled.snapshot,
      apiCalls: apiCalls + assembled.apiCalls,
      refetchedInFull,
    };
  }
}

/**
 * Rebuild the full export from the per-resource endpoints after a 503.
 *
 * Costs 4 + M + Y calls (M = budget months, Y = years of transaction history),
 * against a 200/hour budget, so it is a fallback and never the default path.
 * Transactions are walked a year at a time because since_date alone defaults to
 * one year ago; until_date bounds each window.
 */
async function assemblePiecewise(budgetId: string): Promise<{ snapshot: BudgetSnapshot; apiCalls: number }> {
  const client = getClient();
  let apiCalls = 0;

  const [settings, accountsRes, categoriesRes, monthsRes] = await Promise.all([
    client.plans.getPlanSettingsById(budgetId),
    client.accounts.getAccounts(budgetId),
    client.categories.getCategories(budgetId),
    client.months.getPlanMonths(budgetId),
  ]);
  apiCalls += 4;

  const monthSummaries = monthsRes.data.months.filter((m) => !m.deleted);
  const monthDetails = [];
  for (const summary of monthSummaries) {
    monthDetails.push((await client.months.getPlanMonth(budgetId, summary.month)).data.month);
    apiCalls += 1;
  }

  const firstMonth = monthSummaries[0]?.month ?? `${new Date().getFullYear()}-01-01`;
  const transactions: TransactionSummaryBase[] = [];
  const subtransactions: PlanDetail["subtransactions"] = [];
  for (const [since, until] of yearWindows(firstMonth)) {
    const res = await client.transactions.getTransactionsRaw({
      planId: budgetId,
      sinceDate: since,
      untilDate: until,
    }).then((r) => r.value());
    apiCalls += 1;
    for (const t of res.data.transactions) {
      transactions.push(t);
      for (const leg of t.subtransactions ?? []) subtransactions.push(leg);
    }
  }

  const categories: CategoryBase[] = categoriesRes.data.category_groups.flatMap((g) => g.categories);
  const accounts: AccountBase[] = accountsRes.data.accounts;

  const plan: PlanDetail = {
    id: budgetId,
    name: budgetId,
    currency_format: settings.data.settings.currency_format,
    date_format: settings.data.settings.date_format,
    first_month: monthSummaries[0]?.month,
    last_month: monthSummaries[monthSummaries.length - 1]?.month,
    accounts,
    category_groups: categoriesRes.data.category_groups,
    categories,
    months: monthDetails,
    transactions,
    subtransactions,
  };

  return {
    snapshot: {
      budgetId,
      plan,
      // Assembled from other endpoints, so there is no plan-level knowledge
      // value to delta against; the next refresh fetches in full.
      serverKnowledge: 0,
      fetchedAt: Date.now(),
      assembledPiecewise: true,
    },
    apiCalls,
  };
}

/** [since, until] date pairs covering firstMonth through today, a year at a time. */
function yearWindows(firstMonth: string): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  const today = new Date().toISOString().substring(0, 10);
  let since = firstMonth;
  while (since < today) {
    const untilYear = Number.parseInt(since.substring(0, 4), 10) + 1;
    const until = `${untilYear}${since.substring(4)}`;
    windows.push([since, until > today ? today : until]);
    since = until;
  }
  return windows.length > 0 ? windows : [[firstMonth, today]];
}

function store(requestedId: string, snapshot: BudgetSnapshot) {
  // The export carries the budget's currency format, and the *Base models it
  // returns have no server-formatted amounts, so formatting depends on this.
  setActiveCurrencyFormat(snapshot.plan.currency_format);
  cache.set(requestedId, snapshot);
  cache.set(snapshot.budgetId, snapshot);
}

/** Drop cached snapshots, e.g. after a write that invalidates them. */
export function invalidateBudgetSnapshot(budgetId?: string) {
  if (!budgetId) {
    cache.clear();
    return;
  }
  const snapshot = cache.get(budgetId);
  cache.delete(budgetId);
  if (snapshot) cache.delete(snapshot.budgetId);
}

/** Group names YNAB uses for system-managed categories, used only as a last resort. */
const INTERNAL_GROUP_NAMES = new Set(["Credit Card Payments", "Internal Master Category"]);

/**
 * Ids of the categories YNAB manages itself: Credit Card Payment categories and
 * Inflow: Ready to Assign.
 *
 * `internal` on the category is the supported, localization-proof signal, and
 * the category group carries the same flag. Whether YNAB flags the Credit Card
 * Payments group internal is undocumented, so fall back to the English group
 * names rather than depending on it - a budget in another language loses only
 * the fallback, not the primary signal.
 *
 * These must be excluded from spending analysis, or Inflow: Ready to Assign
 * appears as the largest expense in the budget, and they are rejected as a
 * category_group_id target on create and update.
 */
export function internalCategoryIds(snapshot: BudgetSnapshot): Set<string> {
  const plan = snapshot.plan;
  const internalGroupIds = new Set(
    (plan.category_groups ?? [])
      .filter((g) => g.internal || INTERNAL_GROUP_NAMES.has(g.name))
      .map((g) => g.id)
  );
  const ids = new Set<string>();
  for (const category of plan.categories ?? []) {
    if (category.internal || internalGroupIds.has(category.category_group_id)) ids.add(category.id);
  }
  return ids;
}

/** Months present in the snapshot, chronologically, excluding deleted ones. */
export function snapshotMonths(snapshot: BudgetSnapshot): MonthEntry[] {
  return (snapshot.plan.months ?? [])
    .filter((m) => !m.deleted)
    .sort((a, b) => a.month.localeCompare(b.month));
}
