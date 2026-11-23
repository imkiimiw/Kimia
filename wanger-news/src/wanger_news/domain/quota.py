"""Spreading the provider's daily quota evenly over the day (Phase 6 operations). Pure.

A run may use what is "due" by the end of its slot: quota × (part of the day gone + one run
interval), minus what was already used today. Missed runs leave their share to later runs;
the day's total never goes over the quota, so the quota lasts until every reset — every day
of the month.
"""

from __future__ import annotations

import math


def paced_allowance(
    *,
    quota: int,
    used: int,
    elapsed_fraction: float,
    interval_fraction: float,
    per_run_cap: int,
) -> int:
    """Calls this run may make (0 = wait for the next run)."""
    due = quota * min(1.0, max(0.0, elapsed_fraction) + max(0.0, interval_fraction))
    return max(0, min(per_run_cap, math.floor(due) - used, quota - used))
