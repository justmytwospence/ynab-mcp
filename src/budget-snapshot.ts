import type { PlanDetail } from "ynab";
import { getClient } from "./ynab-client.js";

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
  serverKnowledge: number;
  fetchedAt: number;
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
      };
      store(budgetId, snapshot);
      return { snapshot, apiCalls, refetchedInFull };
    }
    refetchedInFull = true;
  }

  const response = await getClient().plans.getPlanById(budgetId);
  apiCalls += 1;
  const snapshot: BudgetSnapshot = {
    budgetId: response.data.plan.id,
    plan: response.data.plan,
    serverKnowledge: response.data.server_knowledge ?? 0,
    fetchedAt: Date.now(),
  };
  store(budgetId, snapshot);
  return { snapshot, apiCalls, refetchedInFull };
}

function store(requestedId: string, snapshot: BudgetSnapshot) {
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
