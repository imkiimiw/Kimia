"""The subset of Bot API update objects this bot reads. Unknown fields are ignored."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Chat(_Model):
    id: int
    type: str
    title: str | None = None
    username: str | None = None


class User(_Model):
    id: int
    is_bot: bool = False
    first_name: str = ""
    username: str | None = None


class MessageEntity(_Model):
    type: str
    offset: int
    length: int
    url: str | None = None
    language: str | None = None  # pre
    custom_emoji_id: str | None = None
    user: User | None = None  # text_mention


class FileRef(_Model):
    file_id: str
    file_unique_id: str
    width: int | None = None
    height: int | None = None


class MessageOrigin(_Model):
    type: str  # user | hidden_user | chat | channel
    date: int | None = None
    chat: Chat | None = None
    sender_chat: Chat | None = None
    sender_user: User | None = None
    sender_user_name: str | None = None
    message_id: int | None = None

    def key(self) -> str:
        if self.type == "channel" and self.chat is not None and self.message_id is not None:
            return f"chat:{self.chat.id}:{self.message_id}"
        if self.type == "chat" and self.sender_chat is not None:
            return f"chat:{self.sender_chat.id}:{self.date}"
        if self.type == "user" and self.sender_user is not None:
            return f"user:{self.sender_user.id}:{self.date}"
        return f"hidden:{self.sender_user_name}:{self.date}"


class Message(_Model):
    message_id: int
    date: int
    chat: Chat
    from_user: User | None = Field(default=None, alias="from")
    sender_chat: Chat | None = None
    text: str | None = None
    caption: str | None = None
    entities: list[MessageEntity] = []
    caption_entities: list[MessageEntity] = []
    photo: list[FileRef] = []
    video: FileRef | None = None
    animation: FileRef | None = None
    document: FileRef | None = None
    audio: FileRef | None = None
    voice: FileRef | None = None
    video_note: FileRef | None = None
    sticker: FileRef | None = None
    media_group_id: str | None = None
    forward_origin: MessageOrigin | None = None
    author_signature: str | None = None  # a channel post's signer ("Sign messages" on)
    has_protected_content: bool = False
    reply_to_message: Message | None = None

    @property
    def body(self) -> str:
        return self.text or self.caption or ""

    @property
    def body_entities(self) -> list[MessageEntity]:
        return self.entities if self.text else self.caption_entities

    def media(self) -> list[tuple[str, FileRef]]:
        out: list[tuple[str, FileRef]] = []
        if self.photo:
            out.append(("photo", max(self.photo, key=lambda p: (p.width or 0) * (p.height or 0))))
        for kind in ("video", "animation", "document", "audio", "voice", "video_note", "sticker"):
            ref = getattr(self, kind)
            if ref is not None:
                out.append((kind, ref))
        return out


class CallbackQuery(_Model):
    id: str
    from_user: User = Field(alias="from")
    message: Message | None = None
    data: str | None = None


class Update(_Model):
    update_id: int
    message: Message | None = None
    channel_post: Message | None = None
    edited_channel_post: Message | None = None  # Phase 5: an edit in the source channel
    callback_query: CallbackQuery | None = None

    @property
    def kind(self) -> str:
        for name in ("message", "channel_post", "edited_channel_post", "callback_query"):
            if getattr(self, name) is not None:
                return name
        return "other"

    @property
    def chat_id(self) -> int | None:
        msg = self.message or self.channel_post or self.edited_channel_post
        if msg is None and self.callback_query is not None:
            msg = self.callback_query.message
        return msg.chat.id if msg is not None else None


def entity_text(text: str, entity: MessageEntity) -> str:
    """Entity offsets count UTF-16 code units."""
    raw = text.encode("utf-16-le")
    return raw[entity.offset * 2 : (entity.offset + entity.length) * 2].decode(
        "utf-16-le", errors="ignore"
    )
