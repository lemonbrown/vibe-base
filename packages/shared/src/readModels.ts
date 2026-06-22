import type { ReadModel, ReadModelParam } from "./manifest.js";

/**
 * Helpers for validating and binding app-declared read-models. The real
 * read-only guarantee is enforced at execution time (the control plane runs
 * each query inside a READ ONLY transaction); these checks are a fast,
 * author-facing lint so `vibe doctor` and app registration catch obvious
 * mistakes early.
 */

// Write/DDL keywords that must never appear in a read-model. Matched on word
// boundaries, so identifiers like `updated_at` / `created_at` are unaffected.
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|do|vacuum|reindex|cluster|listen|notify|lock|set|reset)\b/i;

/** Returns an error string if the SQL is not an acceptable read-model, else null. */
export function validateReadModelSql(sql: string): string | null {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return "sql is empty";
  if (trimmed.includes(";"))
    return "must be a single statement (no semicolons)";
  if (!/^(select|with)\b/i.test(trimmed))
    return "must start with SELECT or WITH";
  if (FORBIDDEN.test(trimmed))
    return "must be read-only (found a write/DDL keyword)";
  return null;
}

/** The highest positional placeholder ($N) referenced in the SQL, or 0 if none. */
export function maxPlaceholder(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Validate a whole read-model. Returns a list of problems (empty = ok). */
export function validateReadModel(model: ReadModel): string[] {
  const problems: string[] = [];
  const sqlErr = validateReadModelSql(model.sql);
  if (sqlErr) problems.push(`'${model.name}': ${sqlErr}`);
  const max = maxPlaceholder(model.sql);
  if (max > model.params.length)
    problems.push(
      `'${model.name}': sql references $${max} but only ${model.params.length} param(s) are declared`
    );
  return problems;
}

/** Coerce a raw string/JSON value to the declared param type for pg binding. */
export function coerceParam(value: unknown, type: ReadModelParam["type"]): unknown {
  if (value === undefined || value === null || value === "") return null;
  switch (type) {
    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`expected a number, got "${value}"`);
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return /^(true|1|yes)$/i.test(String(value));
    case "date":
    case "string":
    default:
      return String(value);
  }
}

/**
 * Map a name→value param object to the positional array pg expects, coercing
 * each to its declared type. Throws on a missing required param.
 */
export function bindParams(
  model: ReadModel,
  provided: Record<string, unknown> = {}
): unknown[] {
  return model.params.map((p) => {
    const raw = provided[p.name];
    if ((raw === undefined || raw === null || raw === "") && p.required) {
      throw new Error(`missing required param "${p.name}"`);
    }
    return coerceParam(raw, p.type);
  });
}
