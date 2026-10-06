import {planningCanonicalJson} from "./planning.js";

export const MAX_REWORK_INSTRUCTION_CHARACTERS = 12_000;

/** Compare source state, not evaluation output/status or wall-clock metadata. */
export function assertFeedbackSnapshot(frozen: Record<string, unknown>, live: Record<string, unknown>): void {
  const fields = ["schemaVersion", "scopeType", "scopeId", "reviewMode", "requestedChapters", "primaryChapters",
    "downstreamDependencyChapters", "eligibleChapters", "chapters", "canon", "writingPolicy", "outlineHash"];
  for (const field of fields) {
    if (frozen[field] === undefined || planningCanonicalJson(frozen[field]) !== planningCanonicalJson(live[field])) {
      throw new Error(`反馈评估输入已过期（${field}），请重新评估后再确认返工；未修改规则或正文`);
    }
  }
}

export function validateReworkInstruction(instruction: string): string {
  if (!instruction.trim() || instruction.length > MAX_REWORK_INSTRUCTION_CHARACTERS) {
    throw new Error(`合并后的返工要求必须为 1—${MAX_REWORK_INSTRUCTION_CHARACTERS} 个字符，请精简反馈线程后重新评估`);
  }
  return instruction;
}
