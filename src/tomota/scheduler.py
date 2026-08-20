from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


SHANGHAI = ZoneInfo("Asia/Shanghai")


class Scheduler:
    def __init__(self, chapters_per_day: int = 2, buffer_days: int = 7, publish_hour: int = 20):
        if chapters_per_day < 1:
            raise ValueError("chapters_per_day must be positive")
        if buffer_days < 0:
            raise ValueError("buffer_days must be non-negative")
        self.chapters_per_day = chapters_per_day
        self.buffer_days = buffer_days
        self.publish_hour = publish_hour

    def build_schedule(self, chapter_numbers: list[int], *, start: datetime | None = None) -> dict[str, str]:
        # Fanqie readers and the project owner are in China by default.  Keep
        # the stored offset explicit so a browser bridge cannot silently turn
        # an 20:00 China release into a UTC midnight release.
        current = (start or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
        current = current.replace(minute=0, second=0, microsecond=0)
        base_date = current.date()
        if current.hour >= self.publish_hour:
            base_date += timedelta(days=1)
        result: dict[str, str] = {}
        for index, number in enumerate(chapter_numbers):
            day_offset = index // self.chapters_per_day
            slot = index % self.chapters_per_day
            hour = (self.publish_hour + slot) % 24
            target_date = base_date + timedelta(days=day_offset)
            scheduled = datetime(target_date.year, target_date.month, target_date.day, hour, 0, 0, tzinfo=SHANGHAI)
            result[str(number)] = scheduled.isoformat()
        return result

    def needs_more_stock(self, approved_count: int) -> bool:
        return approved_count < self.chapters_per_day * self.buffer_days
