import {createHash} from "node:crypto";

export type PlanningScope = "new_book" | "book" | "volume" | "chapter" | "chapters";
export type PlanningConversationPolicy = "continue" | "user_requirements_only" | "fresh_start";

export interface PlanningConversationInput {
  role: "user" | "assistant";
  text?: string;
  content?: string;
  proposal?: Record<string, unknown> | null;
}

export interface PreparedPlanningConversation {
  policy: PlanningConversationPolicy;
  conversation: Array<{role: "user" | "assistant"; text: string; proposal?: Record<string, unknown>}>;
  retainedUserTurns: number;
  discardedAssistantTurns: number;
  discardedEarlierTurns: number;
}

const FRESH_START_PATTERNS = [
  /(?:不要|不再|别再|禁止).{0,10}(?:沿用|参考|继承|受).{0,10}(?:之前|先前|此前|旧版|旧方案|上一版)/u,
  /(?:故事|方案|设定|大纲).{0,8}(?:不要受|不受).{0,8}(?:之前|先前|此前|旧版|旧方案).{0,6}(?:影响|限制)/u,
  /(?:推倒重来|全部推翻|彻底推翻|从零开始|重新建造|另起炉灶|全新开始)/u,
  /(?:废弃|作废|清除|丢弃).{0,10}(?:之前|先前|此前|旧版|旧方案).{0,10}(?:方案|设定|大纲|候选|内容)/u,
];

// fresh_start 只清「规划对话」这一层（advisory history + 未保存候选），绝不触碰
// 正式大纲（master/chapters）、FoundationContract、Canon 或作者绑定。清空正式契约
// 走独立的 RebuildScopeDialog（前端分 chapter/volume/book 三级显式确认），两者不可混淆。
function isFreshStartInstruction(instruction: string): boolean {
  return FRESH_START_PATTERNS.some((pattern) => pattern.test(instruction));
}

export function currentPlanningConversationEpoch<T extends {role: string; text?: string; content?: string}>(history: T[]): T[] {
  let epochStart = -1;
  history.forEach((item, index) => {
    if (item.role === "user" && isFreshStartInstruction(String(item.text ?? item.content ?? ""))) epochStart = index;
  });
  return epochStart >= 0 ? history.slice(epochStart) : history;
}

/**
 * Planning chat is advisory history, not a second Canon. Rewrites must never
 * silently promote an earlier AI proposal into an active story constraint.
 */
export function planningConversationPolicy(mode: "fill" | "rewrite", instruction: string): PlanningConversationPolicy {
  if (isFreshStartInstruction(instruction)) return "fresh_start";
  return mode === "rewrite" ? "user_requirements_only" : "continue";
}

export function preparePlanningConversation(
  history: PlanningConversationInput[],
  instruction: string,
  mode: "fill" | "rewrite",
  limit = 16,
): PreparedPlanningConversation {
  const policy = planningConversationPolicy(mode, instruction);
  const epochHistory = currentPlanningConversationEpoch(history);
  const discardedBeforeEpoch = history.length - epochHistory.length;
  const normalized = epochHistory.map((item) => ({
    role: item.role,
    text: String(item.text ?? item.content ?? "").trim(),
    proposal: item.proposal && !Array.isArray(item.proposal) && typeof item.proposal === "object" ? item.proposal : undefined,
  })).filter((item) => item.text);
  const current = {role: "user" as const, text: instruction.trim()};

  if (policy === "fresh_start") {
    return {
      policy,
      conversation: [current],
      retainedUserTurns: 1,
      discardedAssistantTurns: normalized.filter((item) => item.role === "assistant").length,
      discardedEarlierTurns: discardedBeforeEpoch + normalized.length,
    };
  }

  if (policy === "user_requirements_only") {
    const userTurns = normalized.filter((item) => item.role === "user").map((item) => ({role: "user" as const, text: item.text}));
    const conversation = [...userTurns, current].slice(-limit);
    return {
      policy,
      conversation,
      retainedUserTurns: conversation.length,
      discardedAssistantTurns: normalized.filter((item) => item.role === "assistant").length,
      discardedEarlierTurns: discardedBeforeEpoch + Math.max(0, userTurns.length + 1 - conversation.length),
    };
  }

  const conversation = [...normalized.map((item) => item.proposal
    ? {role: item.role, text: item.text, proposal: item.proposal}
    : {role: item.role, text: item.text}), current].slice(-limit);
  return {
    policy,
    conversation,
    retainedUserTurns: conversation.filter((item) => item.role === "user").length,
    discardedAssistantTurns: 0,
    discardedEarlierTurns: discardedBeforeEpoch + Math.max(0, normalized.length + 1 - conversation.length),
  };
}

type AnyRecord = Record<string, unknown>;

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as AnyRecord).map(([key, item]) => [key, clone(item)]));
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as AnyRecord)
        .filter(([key]) => !["updated_at", "created_at", "applied_at", "generated_at"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function planningCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function planningHash(value: unknown): string {
  return createHash("sha256").update(planningCanonicalJson(value)).digest("hex");
}

export function planningFoundationContractHash(value: unknown): string {
  const contract = value && !Array.isArray(value) && typeof value === "object" ? value as AnyRecord : {};
  const embedded = String(contract.contract_hash || "").trim();
  if (embedded) return embedded;
  return Object.keys(contract).length ? planningHash(contract) : "";
}

function normalizeBook(value: unknown): AnyRecord {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as AnyRecord : {};
  const metadata = raw.metadata && !Array.isArray(raw.metadata) && typeof raw.metadata === "object" ? raw.metadata as AnyRecord : {};
  const completionMode = raw.completionMode ?? raw.completion_mode ?? metadata.completion_mode ?? "open_ended";
  const target = raw.targetChapters ?? raw.target_chapters ?? metadata.target_chapters ?? null;
  return {
    title: String(raw.title ?? ""),
    author: String(raw.author ?? metadata.author ?? ""),
    synopsis: String(raw.synopsis ?? metadata.synopsis ?? ""),
    genre: String(raw.genre ?? metadata.genre ?? ""),
    completion_mode: String(completionMode || "open_ended"),
    target_chapters: target === null || target === undefined || target === "" ? null : Number(target),
  };
}

function normalizeMaster(value: unknown, fallbackPremise = ""): AnyRecord {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as AnyRecord : {};
  const rolling = raw.rolling_plan && !Array.isArray(raw.rolling_plan) && typeof raw.rolling_plan === "object" ? raw.rolling_plan as AnyRecord : {};
  const volumes = Array.isArray(raw.volumes) ? raw.volumes.map((item, index) => {
    const volume = item && !Array.isArray(item) && typeof item === "object" ? item as AnyRecord : {};
    return {
      volume_id: String(volume.volume_id || `volume-${index + 1}`),
      title: String(volume.title || ""), objective: String(volume.objective || ""),
      main_conflict: String(volume.main_conflict || ""), character_change: String(volume.character_change || ""),
      foreshadowing: String(volume.foreshadowing || ""), ending: String(volume.ending || ""),
    };
  }) : [];
  return {
    version: Number(raw.version || 1),
    completion_mode: String(raw.completion_mode || "open_ended"),
    target_chapters: raw.target_chapters === null || raw.target_chapters === undefined || raw.target_chapters === "" ? null : Number(raw.target_chapters),
    premise: String(raw.premise || fallbackPremise || ""), core_conflict: String(raw.core_conflict || ""), ending_direction: String(raw.ending_direction || ""),
    major_beats: Array.isArray(raw.major_beats) ? raw.major_beats.map(String) : [],
    volumes,
    rolling_plan: {window_size: Number(rolling.window_size || 5), planned_through: Number(rolling.planned_through || 0)},
  };
}

function normalizeChapter(value: unknown): AnyRecord {
  const raw = value && !Array.isArray(value) && typeof value === "object" ? value as AnyRecord : {};
  const contract = raw.contract && !Array.isArray(raw.contract) && typeof raw.contract === "object" ? raw.contract as AnyRecord : raw;
  const result = {...clone(contract) as AnyRecord};
  delete result.book_id;
  delete result.updated_at;
  delete result.created_at;
  if (result.chapter_number !== undefined) result.chapter_number = Number(result.chapter_number);
  if (result.target_word_count !== undefined) result.target_word_count = Number(result.target_word_count);
  if (Array.isArray(result.problem_tags)) result.problem_tags = result.problem_tags.map(String);
  return result;
}

function normalizeChapters(value: unknown): AnyRecord[] {
  const rows = Array.isArray(value) ? value.map(normalizeChapter) : [];
  return rows.sort((left, right) => Number(left.chapter_number || 0) - Number(right.chapter_number || 0));
}

function selectedIds(scope: PlanningScope, context: AnyRecord): AnyRecord {
  const selected = context.selected && !Array.isArray(context.selected) && typeof context.selected === "object" ? context.selected as AnyRecord : {};
  const selectedNumbers = Array.isArray(context.selectedChapterNumbers)
    ? [...new Set(context.selectedChapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0))].sort((left, right) => left - right)
    : [];
  if (scope === "new_book" || scope === "book") return {level: scope, id: scope === "book" ? "book" : "new-book"};
  if (scope === "volume") return {level: scope, id: String(selected.volume_id || context.volumeId || "current")};
  if (scope === "chapter") return {level: scope, id: String(selected.chapter_number || context.chapterNumber || "current"), volume_id: String(selected.volume_id || "")};
  return {level: scope, ids: selectedNumbers};
}

function normalizeBoundary(value: unknown): AnyRecord | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const row = normalizeChapter(value);
  return Object.keys(row).length ? row : null;
}

export function planningSnapshotFromContext(scope: PlanningScope, mode: "fill" | "rewrite", context: Record<string, unknown>): AnyRecord {
  const value = context as AnyRecord;
  const selected = selectedIds(scope, value);
  const selectedNumbers = Array.isArray(value.selectedChapterNumbers)
    ? [...new Set(value.selectedChapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0))].sort((left, right) => left - right)
    : [];
  const boundaries = value.boundaries && !Array.isArray(value.boundaries) && typeof value.boundaries === "object" ? value.boundaries as AnyRecord : {};
  return planningSnapshot({
    scope, mode,
    book: value.book ?? value.form,
    master: value.master ?? value.outline,
    chapters: value.chapters ?? value.initialChapters,
    selected,
    selectedChapterNumbers: selectedNumbers,
    boundaries: {previous: normalizeBoundary(boundaries.previous), next: normalizeBoundary(boundaries.next)},
    clearSelectedOutline: value.clearSelectedOutline === true,
  });
}

export function planningSnapshotFromPayload(value: Record<string, unknown>, scope: PlanningScope, mode: "fill" | "rewrite", metadata: AnyRecord = {}): AnyRecord {
  const selected = metadata.selected_ids && !Array.isArray(metadata.selected_ids) && typeof metadata.selected_ids === "object" ? metadata.selected_ids : {};
  const boundaries = metadata.boundaries && !Array.isArray(metadata.boundaries) && typeof metadata.boundaries === "object" ? metadata.boundaries : {};
  return planningSnapshot({
    scope, mode,
    book: value.book,
    master: value.master,
    chapters: value.chapters,
    selected,
    selectedChapterNumbers: Array.isArray(metadata.selected_chapter_numbers) ? metadata.selected_chapter_numbers : [],
    boundaries,
    clearSelectedOutline: metadata.clear_selected_outline === true,
  });
}

function planningSnapshot(input: {
  scope: PlanningScope; mode: "fill" | "rewrite"; book?: unknown; master?: unknown; chapters?: unknown;
  selected: unknown; selectedChapterNumbers: unknown[]; boundaries: unknown; clearSelectedOutline: boolean;
}): AnyRecord {
  const book = normalizeBook(input.book);
  // Outline persistence has historically used the synopsis as the default
  // premise. Keep candidate replay and the submitted payload on that same
  // canonical state so an empty premise is not treated as a manual drift.
  const state = {book, master: normalizeMaster(input.master, String(book.synopsis || "")), chapters: normalizeChapters(input.chapters)};
  const selected = input.selected && !Array.isArray(input.selected) && typeof input.selected === "object" ? clone(input.selected) : {};
  return {
    schema_version: "planning-editor-snapshot-v1",
    scope: input.scope,
    mode: input.mode,
    state,
    selected_ids: selected,
    selected_chapter_numbers: [...new Set(input.selectedChapterNumbers.map(Number).filter((item) => Number.isInteger(item) && item > 0))].sort((left, right) => left - right),
    boundaries: input.boundaries && !Array.isArray(input.boundaries) && typeof input.boundaries === "object" ? clone(input.boundaries) : {previous: null, next: null},
    clear_selected_outline: input.clearSelectedOutline,
  };
}

export function planningSnapshotHashes(snapshot: AnyRecord): Record<string, string> {
  const state = snapshot.state as AnyRecord;
  return {
    planning_source_hash: planningHash(snapshot),
    book_form_hash: planningHash(state?.book || {}),
    master_outline_hash: planningHash(state?.master || {}),
    chapters_hash: planningHash(state?.chapters || []),
    selected_ids_hash: planningHash(snapshot.selected_ids || {}),
    batch_boundary_hash: planningHash(snapshot.boundaries || {}),
    scope_hash: planningHash({scope: snapshot.scope}),
    mode_hash: planningHash({mode: snapshot.mode, clear_selected_outline: snapshot.clear_selected_outline === true}),
    context_hash: planningHash({scope: snapshot.scope, mode: snapshot.mode, selected_ids: snapshot.selected_ids || {}, selected_chapter_numbers: snapshot.selected_chapter_numbers || [], boundaries: snapshot.boundaries || {}, clear_selected_outline: snapshot.clear_selected_outline === true}),
  };
}

export function planningPersistedStateHash(value: {book?: unknown; master?: unknown; chapters?: unknown}): string {
  const snapshot = planningSnapshotFromContext("book", "fill", value as Record<string, unknown>);
  return planningHash(snapshot.state || {});
}

export function applyPlanningProposal(snapshot: AnyRecord, scope: PlanningScope, proposal: Record<string, unknown>): AnyRecord {
  const next = clone(snapshot) as AnyRecord;
  const state = next.state as AnyRecord;
  const book = state.book as AnyRecord;
  const master = state.master as AnyRecord;
  const chapters = state.chapters as AnyRecord[];
  const selected = next.selected_ids && !Array.isArray(next.selected_ids) && typeof next.selected_ids === "object" ? next.selected_ids as AnyRecord : {};
  if (scope === "book") {
    if (proposal.synopsis !== undefined) book.synopsis = String(proposal.synopsis || book.synopsis || "");
    if (proposal.genre !== undefined) book.genre = String(proposal.genre || book.genre || "");
    if (proposal.premise !== undefined) master.premise = String(proposal.premise || master.premise || "");
    if (proposal.core_conflict !== undefined) master.core_conflict = String(proposal.core_conflict || master.core_conflict || "");
    if (proposal.ending_direction !== undefined) master.ending_direction = String(proposal.ending_direction || master.ending_direction || "");
    if (Array.isArray(proposal.major_beats)) master.major_beats = proposal.major_beats.map(String);
    if (Array.isArray(proposal.volumes)) master.volumes = proposal.volumes.map((item, index) => {
      const raw = item && !Array.isArray(item) && typeof item === "object" ? item as AnyRecord : {};
      return {...raw, volume_id: String(raw.volume_id || (master.volumes as AnyRecord[])[index]?.volume_id || `volume-${index + 1}`)};
    });
  } else if (scope === "volume") {
    const id = String(selected.id || "");
    const index = (master.volumes as AnyRecord[]).findIndex((item) => String(item.volume_id) === id);
    if (index >= 0) (master.volumes as AnyRecord[])[index] = {...(master.volumes as AnyRecord[])[index], ...proposal, volume_id: id};
  } else if (scope === "chapter") {
    const number = Number(selected.id || 0);
    const index = chapters.findIndex((item) => Number(item.chapter_number) === number);
    if (index >= 0) chapters[index] = {...chapters[index], ...proposal, chapter_number: number, volume_id: chapters[index].volume_id || "volume-1"};
  } else if (scope === "chapters") {
    const selectedNumbers = new Set((Array.isArray(next.selected_chapter_numbers) ? next.selected_chapter_numbers : []).map(Number));
    const replacements = Array.isArray(proposal.chapters) ? proposal.chapters : [];
    const byNumber = new Map(replacements.filter((item): item is AnyRecord => Boolean(item) && !Array.isArray(item) && typeof item === "object").map((item) => [Number(item.chapter_number), item]));
    for (let index = 0; index < chapters.length; index += 1) {
      const number = Number(chapters[index].chapter_number);
      if (!selectedNumbers.has(number)) continue;
      const replacement = byNumber.get(number);
      if (!replacement) continue;
      const base = next.clear_selected_outline === true ? {chapter_number: number, volume_id: chapters[index].volume_id || "volume-1"} : chapters[index];
      chapters[index] = {...base, ...replacement, chapter_number: number, volume_id: chapters[index].volume_id || "volume-1"};
    }
  }
  return next;
}
