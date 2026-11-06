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
};
