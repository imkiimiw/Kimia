"""Gregorian → Jalali (Solar Hijri) conversion for display. Arithmetic algorithm, no I/O."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from wanger_news.domain.text import to_persian_digits

_CUMULATIVE_DAYS = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)


def gregorian_to_jalali(gy: int, gm: int, gd: int) -> tuple[int, int, int]:
    gy2 = gy + 1 if gm > 2 else gy
    days = (
        355666
        + 365 * gy
        + (gy2 + 3) // 4
        - (gy2 + 99) // 100
        + (gy2 + 399) // 400
        + gd
        + _CUMULATIVE_DAYS[gm - 1]
    )
    jy = -1595 + 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm, jd = 1 + days // 31, 1 + days % 31
    else:
        jm, jd = 7 + (days - 186) // 30, 1 + (days - 186) % 30
    return jy, jm, jd


def format_tehran(moment: datetime, timezone: str = "Asia/Tehran") -> str:
    """``۱۴۰۵/۰۸/۲۷ ساعت ۱۴:۳۰`` in the display time zone."""
    local = moment.astimezone(ZoneInfo(timezone))
    jy, jm, jd = gregorian_to_jalali(local.year, local.month, local.day)
    return to_persian_digits(f"{jy:04d}/{jm:02d}/{jd:02d} ساعت {local:%H:%M}")


def format_date_fa(moment: datetime, timezone: str = "Asia/Tehran") -> str:
    """``۱۴۰۵/۰۸/۳۰`` (the local Jalali date)."""
    local = moment.astimezone(ZoneInfo(timezone))
    jy, jm, jd = gregorian_to_jalali(local.year, local.month, local.day)
    return to_persian_digits(f"{jy:04d}/{jm:02d}/{jd:02d}")


def format_time_fa(moment: datetime, now: datetime, timezone: str = "Asia/Tehran") -> str:
    """``۱۴:۳۰`` on the same local day as ``now``, else ``۰۸/۲۹ ۱۴:۳۰`` (month/day)."""
    zone = ZoneInfo(timezone)
    local, today = moment.astimezone(zone), now.astimezone(zone)
    if local.date() == today.date():
        return to_persian_digits(f"{local:%H:%M}")
    _, jm, jd = gregorian_to_jalali(local.year, local.month, local.day)
    return to_persian_digits(f"{jm:02d}/{jd:02d} {local:%H:%M}")
