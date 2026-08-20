from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .models import utc_now
from .store import ProjectStore


ALLOWED_OPERATIONS = {
    "view_dashboard", "view_works", "view_metrics", "create_work", "maintain_work",
    "edit_chapter_draft", "inspect_review", "schedule_chapter", "submit_chapter", "publish_chapter",
    "reconcile_platform_state",
}
FORBIDDEN_OPERATIONS = {
    "real_name", "identity_document", "face_verification", "contract", "copyright_agreement",
    "earnings", "bank_card", "withdrawal", "tax", "password", "phone_binding", "login_devices",
    "security_settings", "delete_work", "delete_published_chapter",
}


class AccountPolicyError(RuntimeError):
    pass


@dataclass
class FanqieSessionState:
    status: str
    writer_url: str = "https://fanqienovel.com/main/writer/home"
    writer_name: str = ""
    visible_works: list[dict[str, Any]] = field(default_factory=list)
    checked_at: str = field(default_factory=utc_now)
    note: str = "只记录页面可见会话状态，不记录 Cookie、Token、密码、验证码或二维码内容"

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


class FanqieAccountPolicy:
    def __init__(self, store: ProjectStore):
        self.store = store

    def assert_allowed(self, operation: str, *, action_confirmation: bool = False) -> None:
        if operation in FORBIDDEN_OPERATIONS:
            raise AccountPolicyError(f"操作超出作品运营范围，必须针对具体敏感操作重新授权：{operation}")
        if operation not in ALLOWED_OPERATIONS:
            raise AccountPolicyError(f"未定义的账号操作，安全停止：{operation}")
        if operation in {"create_work", "maintain_work", "edit_chapter_draft", "schedule_chapter", "submit_chapter", "publish_chapter"} and not action_confirmation:
            raise AccountPolicyError(f"云端写入需要操作时即时确认：{operation}")

    def record_session(self, book_id: str, state: FanqieSessionState) -> None:
        if state.status not in {"logged_in", "auth_required", "human_action_required", "unknown"}:
            raise AccountPolicyError(f"invalid session status: {state.status}")
        path = self.store.book_dir(book_id) / "publish" / "fanqie-session.json"
        self.store.write_json(path, state.to_dict())
        self.store.append_event(book_id, None, "fanqie_session_checked", {"status": state.status, "writer_url": state.writer_url, "visible_work_count": len(state.visible_works)})
