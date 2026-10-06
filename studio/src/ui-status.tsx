export const statusLabel = (value?: string) => ({
  running: "运行中", queued: "排队中", approved: "已通过", blocked: "已阻塞", completed: "已完成",
  succeeded: "已校验", failed: "失败", cancelled: "已取消", interrupted: "已中断", auth_required: "需要登录", timeout: "已超时",
  awaiting_choice: "旧任务待迁移", logged_in: "已登录", human_action_required: "需要人工处理", unknown: "未检查",
  ui_changed: "页面已变化", idle: "未同步", authenticated: "已认证", planned: "待生成",
  reviewed_pending_approval: "已审完待批准", scheduled: "已排期", submitted: "已提交平台",
  published: "已发布", modified_after_review: "审后有修改", waiting_for_generation: "等待生成",
  prompt_ready: "已规划待生成", draft_unreviewed: "已有正文 · 待严格审查", legacy_unreviewed: "已有正文 · 待严格审查",
  invalidated: "依赖已过期 · 待重做",
} as Record<string, string>)[value || ""] || value || "未知";

export function StatusPill({value}: {value?: string}) {
  return <span className={`status-pill status-${value || "unknown"}`}><span/>{statusLabel(value)}</span>;
}
