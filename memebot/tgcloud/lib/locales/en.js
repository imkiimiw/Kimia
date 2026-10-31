/*
 * English. Same keys as fa.js (the default language); see fa.js for the format.
 * A value may be { one, other } (picked by the {n} placeholder) for plural forms.
 */
export default {
  _name: 'English',

  'lang.prompt': '🌐 Choose the bot language:',
  'lang.saved': '✅ The bot will speak English.',

  'start.welcome': '😎 Hi {name}!\n\n📤 <b>Upload a meme:</b> send me a photo, GIF, video, sticker or voice message, then write a few keywords for it.\n🔎 <b>Search:</b> in any chat, type <code>@{bot} word</code> and pick a meme.',
  'help': '❓ <b>Help</b>\n\n📤 <b>Upload:</b> send the meme (photo, GIF, video, sticker or voice) here, then write its keywords: names, the famous line, the mood. Up to {limit} memes a day.\n\n🔎 <b>Search:</b> in any chat, type <code>@{bot} word</code>. With nothing after the name you get your recent memes and the most popular ones.\n\n📂 /my — my memes (view and delete)\n🌐 /lang — change language\n✖️ /cancel — cancel an upload',

  'menu.upload': '📤 Upload a meme',
  'menu.my': '📂 My memes',
  'menu.search': '🔎 Search',
  'menu.lang': '🌐 Language / زبان',
  'menu.help': '❓ Help',

  'upload.how': '📤 Send your meme: a photo, GIF, video, sticker or voice message.',
  'upload.ask': '🔤 Now write a few keywords for this meme.\nFor example: <i>character name, famous line, mood</i>\n\nThe more precise, the easier it is to find.',
  'upload.replaced': '♻️ The previous meme that was waiting for keywords was dropped.',
  'upload.cancel_btn': '✖️ Cancel',
  'upload.saved': '✅ Meme saved!\n🔤 {kw}\n\nTry it: <code>@{bot} {q}</code>\n📊 Uploads today: {used} of {limit}',
  'upload.try_btn': '🔎 Try it',
  'upload.dup_own': '🙂 You already uploaded this meme.\n🔤 {kw}',
  'upload.dup': '🙂 This meme is already in the bot.\n🔤 {kw}',
  'upload.limit': '⛔️ You uploaded {limit} memes today, the daily maximum.\nYou can upload again after 00:00 Tehran time.',
  'upload.unsupported': '🤷 I can\'t take this kind of message.\nSend a photo, GIF, video, sticker or voice message (videos and GIFs not as files).',
  'upload.album': '📚 Albums aren\'t accepted: send memes one by one.',
  'upload.expired': '⌛️ This upload expired: send the meme again.',
  'kw.empty': '✏️ No usable keywords found. Write a few words (letters or digits).',
  'kw.long': '✏️ The keywords are too long (at most {max} characters). Make them shorter.',
  'kw.links': '🚫 Links and @usernames aren\'t allowed in keywords. Write them again.',
  'cancel.done': '✖️ Upload cancelled.',
  'cancel.none': 'Nothing to cancel.',
  'hint': '🙂 To upload, send me a meme. To search, type <code>@{bot} word</code> in any chat.',
  'hint.search_btn': '🔎 Search “{q}”',

  'my.empty': '📂 You haven\'t uploaded any memes yet. Send one to get started!',
  'my.title': '📂 <b>My memes</b> ({n})\nTap one to see it and delete it if you like.\nPage {p} of {pages}',
  'my.prev': '« Previous',
  'my.next': 'Next »',
  'my.card': { one: '🔤 {kw}\n📊 Sent {n} time\n🕒 {ago}', other: '🔤 {kw}\n📊 Sent {n} times\n🕒 {ago}' },
  'my.delete_btn': '🗑 Delete',
  'my.yes': '✅ Yes, delete',
  'my.no': '↩️ No',
  'my.deleted': '🗑 Deleted.',
  'my.gone': 'This meme no longer exists.',

  'inline.none': '😕 Not found: upload it yourself!',
  'inline.upload': '📤 Upload a new meme',
  'inline.empty_db': '📤 No memes yet: be the first!',

  'spam.muted': { one: '🐢 Slow down! I\'ll ignore your messages for {n} minute.', other: '🐢 Slow down! I\'ll ignore your messages for {n} minutes.' },
  'spam.wait': '🐢 Please wait a little.',
  'error': '⚠️ Something went wrong. Please try again.',

  'ago.now': 'just now',
  'ago.m': { one: '{n} minute ago', other: '{n} minutes ago' },
  'ago.h': { one: '{n} hour ago', other: '{n} hours ago' },
  'ago.d': { one: '{n} day ago', other: '{n} days ago' },

  'cmd.start': 'Start',
  'cmd.my': 'My memes',
  'cmd.lang': 'Change language',
  'cmd.help': 'Help',
  'cmd.cancel': 'Cancel upload',
  'bot.description': 'Send a meme, add keywords, and find and send it in any chat with @botname.',
  'bot.short': 'Upload memes and send them in any chat',

  'owner.backup_fail': '⚠️ Backing up meme #m{id} to the channel failed:\n<code>{err}</code>\n\nThe bot must be an admin of the backup channel with "Post messages". (This alert comes at most every 3 hours.)',
  'owner.setup': '🛠 <b>Setup</b>\n\n{lines}',
  'owner.setup.commands': '✅ Commands and bot description set for {n} languages.',
  'owner.setup.commands_fail': '❌ Setting the commands failed: <code>{err}</code>',
  'owner.setup.inline_on': '✅ Inline mode is on.',
  'owner.setup.inline_off': '❌ Inline mode is off: send /setinline to @BotFather.',
  'owner.setup.feedback': 'ℹ️ To count uses, choose 100% in @BotFather → /setinlinefeedback (the Bot API can\'t check this).',
  'owner.setup.backup_ok': '✅ Backup channel: {title}',
  'owner.setup.backup_bad': '❌ Backup channel ({ch}): {err}',
  'owner.setup.backup_off': '⚠️ No backup channel set (MEMEBOT_BACKUP_CHANNEL_ID): uploads are not backed up.',
  'owner.setup.not_admin': 'the bot is not an admin of this channel with "Post messages"',
};
