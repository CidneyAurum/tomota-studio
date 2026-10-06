/**
 * Pure compatibility helpers for turning the persisted author policy into
 * planning inputs.  Keeping source selection separate from the HTTP server
 * makes the fallback rules testable and prevents an empty legacy array from
 * shadowing a populated policy.
 */

type RecordValue = Record<string, unknown>;

const AUTHOR_DESIGN_STAGES = ["book_design", "volume_design", "chapter_design"] as const;
const AUTHOR_DESIGN_STAGE_SET = new Set<string>(AUTHOR_DESIGN_STAGES);

function record(value: unknown): RecordValue {
  return value && !Array.isArray(value) && typeof value === "object" ? value as RecordValue : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    const items = array(value);
    if (items.length) return items;
  }
  return [];
}

function nonEmptyRecord(...values: unknown[]): RecordValue {
  for (const value of values) {
    const candidate = record(value);
    if (Object.keys(candidate).length) return candidate;
  }
  return {};
}

function mergeRecords(...values: unknown[]): RecordValue {
  return values.reduce<RecordValue>((merged, value) => Object.assign(merged, record(value)), {});
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

export type AuthorPolicyPlanningInputs = {
  metadata: RecordValue;
  values: unknown[];
  blueprint: RecordValue;
};

/** Normalize a profile rule's stage scope for planning compatibility. */
export function selectAuthorPlanningStages(value: unknown): string[] {
  const declared = array(value).map(String);
  if (!declared.length) return [...AUTHOR_DESIGN_STAGES];
  return declared.filter((stage) => AUTHOR_DESIGN_STAGE_SET.has(stage));
}

/** Select the most complete rule source from a compiled or legacy policy. */
export function selectAuthorPolicyPlanningInputs(value: unknown): AuthorPolicyPlanningInputs {
  const policy = record(value);
  const contract = record(policy.author_book_contract);
  const style = record(policy.style_profile);
  const binding = mergeRecords(policy.author_binding, policy.author_binding_snapshot);
  const styleValues = [...array(style.rules), ...array(style.style_dimensions)];
  const values = nonEmptyArray(contract.design_rules, policy.active_rules, styleValues);
  const blueprint = nonEmptyRecord(
    contract.application_blueprint,
    contract.design_blueprint,
    policy.application_blueprint,
    policy.design_blueprint,
    style.application_blueprint,
    style.design_blueprint,
  );
  return {
    values,
    blueprint,
    metadata: {
      author_version_id: firstDefined(contract.author_version_id, binding.version_id, policy.author_version_id),
      author_id: firstDefined(contract.author_id, binding.author_id, policy.author_id),
      version_number: firstDefined(contract.version_number, binding.version_number, policy.version_number),
      profile_hash: firstDefined(contract.profile_hash, binding.profile_hash, policy.profile_hash),
      is_system: Boolean(firstDefined(contract.is_system, binding.is_system, policy.is_system)),
    },
  };
}

function ruleSignature(value: unknown): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const item = value as RecordValue;
  const instruction = String(item.writing_instruction || item.rule || item.finding || "").trim();
  if (!instruction) return null;
  const scope = Array.isArray(item.applies_to) ? item.applies_to.map(String).sort() : [];
  return JSON.stringify({
    instruction,
    scope,
  });
}

/** Drop exact rule duplicates without treating different instructions as repeats. */
export function dedupeAuthorPlanningInputs(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const signature = ruleSignature(value);
    if (!signature) return true;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/** Select rules from an old foundation snapshot without losing nested fields. */
export function selectFoundationSnapshotInputs(snapshot: unknown, bindingValue: unknown = {}): AuthorPolicyPlanningInputs {
  const raw = record(snapshot);
  const nested = record(raw.author_book_contract);
  // Older foundation snapshots may carry the binding under either the
  // explicit argument, author_binding_snapshot, or author_binding. Merge
  // fields so a partial legacy binding cannot erase the remaining lineage.
  const binding = mergeRecords(raw.author_binding, raw.author_binding_snapshot, bindingValue);
  const source = Object.keys(nested).length ? nested : raw;
  const values = nonEmptyArray(
    source.design_rules,
    source.core_design_dimensions,
    source.rules,
    source.design_dimensions,
    raw.design_rules,
    raw.core_design_dimensions,
    raw.rules,
    raw.design_dimensions,
  );
  const blueprint = nonEmptyRecord(
    source.application_blueprint,
    source.design_blueprint,
    raw.application_blueprint,
    raw.design_blueprint,
  );
  return {
    values,
    blueprint,
    metadata: {
      author_version_id: firstDefined(source.author_version_id, raw.author_version_id, binding.author_version_id, binding.version_id),
      author_id: firstDefined(source.author_id, raw.author_id, binding.author_id),
      version_number: firstDefined(source.version_number, raw.version_number, binding.version_number),
      profile_hash: firstDefined(source.profile_hash, raw.profile_hash, binding.profile_hash),
      is_system: Boolean(firstDefined(source.is_system, raw.is_system, binding.is_system)),
    },
  };
}
