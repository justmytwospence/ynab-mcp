/**
 * Live read-only checks against a real YNAB budget.
 *
 * Answers the three questions the offline tests cannot:
 *   1. Does a delta getPlanById carry months[].categories?
 *   2. Is the Credit Card Payments group flagged internal?
 *   3. Does balance == prior + budgeted + activity hold for a payment category,
 *      or does YNAB move credit coverage outside those two fields?
 *
 * Reads only. Makes at most 3 requests. Prints findings, never the token.
 *
 * Run:  npx tsx scripts/live-check.ts
 * Token: $YNAB_API_TOKEN, else the ynab MCP server's env in the Claude
 * desktop config.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

function loadToken(): string {
  if (process.env.YNAB_API_TOKEN) return process.env.YNAB_API_TOKEN;

  const candidates = [
    `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`,
    `${homedir()}/.claude.json`,
  ];
  for (const path of candidates) {
    let config: any;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const servers = { ...(config.mcpServers ?? {}) };
    for (const project of Object.values(config.projects ?? {}) as any[]) {
      Object.assign(servers, project?.mcpServers ?? {});
    }
    for (const [name, server] of Object.entries(servers) as Array<[string, any]>) {
      const env = server?.env ?? {};
      for (const [key, value] of Object.entries(env) as Array<[string, string]>) {
        if (/ynab/i.test(name + key) && typeof value === "string" && value.length > 20) {
          console.log(`Using the token from ${path} (server "${name}", env ${key}).\n`);
          return value;
        }
      }
    }
  }
  throw new Error(
    "No YNAB token found. Set YNAB_API_TOKEN, or add it to the ynab MCP server's env in the Claude desktop config."
  );
}

const TOKEN = loadToken();
const API = "https://api.ynab.com/v1";

async function get(path: string): Promise<any> {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} on ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const money = (m: number) => (m / 1000).toFixed(2);

const budgetId = process.argv[2] ?? "last-used";

console.log("=".repeat(72));
console.log("1. Full export shape");
console.log("=".repeat(72));
const full = await get(`/budgets/${budgetId}`);
const plan = full.data.budget ?? full.data.plan;
const knowledge = full.data.server_knowledge;
const months = plan.months ?? [];
console.log(`Budget: ${plan.name}`);
console.log(`Months: ${months.length}, transactions: ${(plan.transactions ?? []).length}`);
console.log(`Months carrying per-category detail: ${months.filter((m: any) => Array.isArray(m.categories)).length}/${months.length}`);
console.log(`server_knowledge: ${knowledge}`);

console.log(`\n${"=".repeat(72)}`);
console.log("2. Is the Credit Card Payments group flagged internal?");
console.log("=".repeat(72));
const groups = plan.category_groups ?? [];
for (const g of groups) {
  if (g.internal || /credit card|internal master/i.test(g.name)) {
    console.log(`  group "${g.name}": internal=${g.internal}, hidden=${g.hidden}, deleted=${g.deleted}`);
  }
}
const ccCategories = (plan.categories ?? []).filter((c: any) => c.internal);
console.log(`  categories flagged internal: ${ccCategories.length}`);
for (const c of ccCategories.slice(0, 8)) {
  const group = groups.find((g: any) => g.id === c.category_group_id);
  console.log(`    - "${c.name}" (group "${group?.name}", group.internal=${group?.internal})`);
}
console.log(
  ccCategories.length > 0
    ? "  => the category-level internal flag is populated and usable."
    : "  => NO categories are flagged internal; the group-name fallback is load-bearing."
);

console.log(`\n${"=".repeat(72)}`);
console.log("3. Does balance == prior + budgeted + activity hold for payment categories?");
console.log("=".repeat(72));
const creditAccounts = (plan.accounts ?? []).filter(
  (a: any) => !a.deleted && a.on_budget && ["creditCard", "lineOfCredit"].includes(a.type)
);
console.log(`On-budget credit accounts: ${creditAccounts.length}`);
const sorted = [...months].sort((a: any, b: any) => a.month.localeCompare(b.month));
for (const category of ccCategories) {
  let previous: number | null = null;
  let nonZeroResiduals = 0;
  let totalResidual = 0;
  let sample = "";
  for (const m of sorted) {
    const row = (m.categories ?? []).find((c: any) => c.id === category.id);
    if (!row) continue;
    if (previous !== null) {
      const residual = row.balance - (previous + row.budgeted + row.activity);
      if (residual !== 0) {
        nonZeroResiduals += 1;
        totalResidual += residual;
        if (!sample) {
          sample = `${m.month}: balance ${money(row.balance)} vs prior ${money(previous)} + budgeted ${money(row.budgeted)} + activity ${money(row.activity)} -> residual ${money(residual)}`;
        }
      }
    }
    previous = row.balance;
  }
  console.log(`\n  "${category.name}": ${nonZeroResiduals} of ${sorted.length} months have a nonzero residual`);
  if (sample) console.log(`    first: ${sample}`);
  if (nonZeroResiduals > 0) console.log(`    total residual across all months: ${money(totalResidual)}`);
  console.log(
    nonZeroResiduals === 0
      ? "    => budgeted + activity fully explains the balance. The drift check can be a hard invariant."
      : "    => YNAB moves credit coverage outside budgeted/activity. Keep reporting it, do not assert it."
  );
}

console.log(`\n${"=".repeat(72)}`);
console.log("4. Does a delta carry months[].categories?");
console.log("=".repeat(72));
const delta = await get(`/budgets/${budgetId}?last_knowledge_of_server=${knowledge}`);
const deltaPlan = delta.data.budget ?? delta.data.plan;
const deltaMonths = deltaPlan.months ?? [];
console.log(`Delta at the current knowledge value returned ${deltaMonths.length} month(s).`);
if (deltaMonths.length === 0) {
  console.log("Nothing has changed since the full export, so this is inconclusive.");
  const older = Math.max(0, knowledge - 200);
  console.log(`\nRetrying from an older knowledge value (${older}) to force changes...`);
  const delta2 = await get(`/budgets/${budgetId}?last_knowledge_of_server=${older}`);
  const plan2 = delta2.data.budget ?? delta2.data.plan;
  const months2 = plan2.months ?? [];
  console.log(`Returned ${months2.length} month(s), ${months2.filter((m: any) => Array.isArray(m.categories)).length} with a categories array.`);
  if (months2.length > 0) {
    const withCats = months2.filter((m: any) => Array.isArray(m.categories));
    console.log(
      withCats.length === months2.length
        ? "=> Deltas DO carry month category detail. The snapshot can merge them; the full-refetch fallback is belt and braces."
        : "=> Deltas DO NOT reliably carry month category detail. The full-refetch fallback is load-bearing - keep it."
    );
    console.log(`   changed transactions: ${(plan2.transactions ?? []).length}, tombstones: ${(plan2.transactions ?? []).filter((t: any) => t.deleted).length}`);
  }
} else {
  const withCats = deltaMonths.filter((m: any) => Array.isArray(m.categories));
  console.log(`${withCats.length} of ${deltaMonths.length} carry a categories array.`);
  console.log(
    withCats.length === deltaMonths.length
      ? "=> Deltas DO carry month category detail."
      : "=> Deltas DO NOT reliably carry month category detail. Keep the full-refetch fallback."
  );
}

console.log("\nDone. Read-only; nothing was modified.");
