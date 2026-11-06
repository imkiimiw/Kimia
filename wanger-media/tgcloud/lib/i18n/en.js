// English texts (also the fallback for missing keys). Telegram HTML; {vars} are filled by lib/i18n/index.js.
export default {
  'lang.prompt': '🌐 Please choose your language:',
  'lang.saved': '✅ Language: {name}',

  'btn.language': '🌐 Language',
  'btn.home': '🏠 Home',
  'btn.back': '⬅️ Back',
  'btn.check_join': '✅ I joined — check again',

  'join.text': '🔒 To use the bot, join these channels first, then tap “Check again”.',
  'join.unknown': '⚠️ I couldn’t check {n} channel(s) right now. If you have joined, try again in a minute.',
  'join.button': '📢 {title}',
  'join.not_yet': 'You haven’t joined every channel yet.',
  'join.ok': '✅ Membership confirmed. Thank you!',
  'join.cant_check': '⚠️ I can’t check right now. Please try again in a minute.',

  'welcome.text': '👋 Hi {name}!\n\nWelcome to <b>Wanger Media</b>.\n\n🚧 Downloading isn’t available yet: the bot is being built step by step. Once it’s ready, you’ll be able to send a link right here.',

  'menu.expired': 'This menu has expired.',
  'banned.forever': '⛔ You are not allowed to use this bot.',
  'banned.until': '⛔ You are not allowed to use this bot until {date}.',
  'maintenance': '🛠 The bot is under maintenance. Please try again later.',
  'error.generic': '⚠️ Something went wrong. Please try again.',

  'alert.channel': '⚠️ Forced-join channel {channel}: I can’t check its members ({detail}).\nMake the bot an admin there; until then users can’t pass the membership check.',
  'alert.lost_admin': '⚠️ The bot is no longer an admin in the forced-join channel {channel}. The membership check won’t work until it is an admin again.',
  'alert.error': '⚠️ Error in {source}:\n{message}',

  // Phase 2: dashboard
  'btn.downloads': '📥 My downloads',
  'btn.settings': '⚙️ Settings',
  'btn.help': '❓ Help',
  'btn.about': 'ℹ️ About',
  'btn.accept': '✅ I accept',
  'btn.quality': '🎞 Quality',
  'btn.prev': '🔼 Newer',
  'btn.next': '🔽 Older',
  'disclaimer.text': '📜 <b>Before you start</b>\n\nWanger Media only fetches media that the platforms make publicly available. You are responsible for having the right to download and share what you request, and for respecting the platforms’ terms and the creators’ copyright.\n\nTap “I accept” to continue.',
  'disclaimer.ok': '✅ Thank you!',
  'history.title': '📥 <b>My downloads</b>',
  'history.empty': 'You haven’t downloaded anything yet.',
  'history.page': 'Page {page} of {pages} · showing your latest {max}.',
  'history.item': '{icon} {date} · {platform}\n{url}',
  'settings.text': '⚙️ <b>Settings</b>\n\n🌐 Language: {lang}\n🎞 Preferred quality: {quality}',
  'quality.text': '🎞 <b>Preferred quality</b>\n\n• <b>{auto}</b>: the best quality Telegram can deliver quickly.\n• <b>{best}</b>: the highest quality that fits Telegram’s limits; larger files.\n• <b>{small}</b>: a smaller file when the platform offers one.\n\nIt applies to downloads once they are available.',
  'quality.auto': 'Auto (recommended)',
  'quality.best': 'Best quality',
  'quality.small': 'Data saver',
  'quality.saved': '✅ Quality: {name}',
  'help.text': '❓ <b>Help</b>\n\n/start — main menu\n/downloads — your download history\n/settings — language and preferred quality\n/language — change the language\n/about — about this bot\n\n🚧 Downloading isn’t available yet. When it is, this page will explain how to use it and which platforms are supported.',
  'about.text': 'ℹ️ <b>Wanger Media</b> · version {version}\n\nA multilingual bot for getting media from links, built step by step on Telegram Serverless. It is not affiliated with any of the platforms.\n\n🔐 Stored about you: your Telegram id, name, username, language, settings, activity dates and download history — nothing else.\n\n📢 Channel:\n@{channel}',
};
