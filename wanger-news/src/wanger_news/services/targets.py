"""Which channel posts go to. Phase 1 may only post to the TEST channel (spec §16)."""

from __future__ import annotations

from wanger_news import PHASE
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ChannelRole
from wanger_news.services.context import Target

#: The first phase allowed to post to the main channel.
MAIN_CHANNEL_FROM_PHASE = 2


class TargetError(Exception):
    pass


def resolve_target(
    test: ChatRef | None, main: ChatRef | None, *, want_main: bool = False, phase: int = PHASE
) -> Target | None:
    if want_main:
        if phase < MAIN_CHANNEL_FROM_PHASE:
            raise TargetError(f"phase {phase} publishes to the test channel only")
        if main is None:
            raise TargetError("WANGER_NEWS_MAIN_CHANNEL is not set")
        return Target(ChannelRole.MAIN, main)
    if test is None:
        return None
    if main is not None and test == main:
        raise TargetError("the test channel and the main channel must differ")
    return Target(ChannelRole.TEST, test)
