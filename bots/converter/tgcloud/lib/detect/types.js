// The file types the detector can report (spec §6). Pure.
// exts: extensions that correctly describe the type (the first is canonical; Detect & Fix uses it);
// family: menu grouping; dangerous: executables / scripts / macro documents — reported only, never
// converted or renamed (spec §6).

const T = (label, family, exts, mime, extra = {}) => ({ label, family, exts, mime, ...extra });

export const TYPES = {
  // images
  jpeg: T('JPEG', 'image', ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/jpeg'),
  png: T('PNG', 'image', ['png'], 'image/png'),
  gif: T('GIF', 'image', ['gif'], 'image/gif'),
  webp: T('WEBP', 'image', ['webp'], 'image/webp'),
  bmp: T('BMP', 'image', ['bmp', 'dib'], 'image/bmp'),
  tiff: T('TIFF', 'image', ['tif', 'tiff'], 'image/tiff'),
  ico: T('ICO', 'image', ['ico'], 'image/x-icon'),
  avif: T('AVIF', 'image', ['avif'], 'image/avif'),
  heic: T('HEIC', 'image', ['heic', 'heif'], 'image/heic'),
  psd: T('PSD', 'image', ['psd'], 'image/vnd.adobe.photoshop'),
  svg: T('SVG', 'image', ['svg'], 'image/svg+xml'),
  // documents
  pdf: T('PDF', 'pdf', ['pdf'], 'application/pdf'),
  docx: T('DOCX', 'document', ['docx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xlsx: T('XLSX', 'document', ['xlsx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  pptx: T('PPTX', 'document', ['pptx'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  docm: T('DOCM', 'document', ['docm'], 'application/vnd.ms-word.document.macroEnabled.12', { dangerous: 'macro' }),
  xlsm: T('XLSM', 'document', ['xlsm'], 'application/vnd.ms-excel.sheet.macroEnabled.12', { dangerous: 'macro' }),
  pptm: T('PPTM', 'document', ['pptm'], 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', { dangerous: 'macro' }),
  odt: T('ODT', 'document', ['odt'], 'application/vnd.oasis.opendocument.text'),
  ods: T('ODS', 'document', ['ods'], 'application/vnd.oasis.opendocument.spreadsheet'),
  odp: T('ODP', 'document', ['odp'], 'application/vnd.oasis.opendocument.presentation'),
  epub: T('EPUB', 'document', ['epub'], 'application/epub+zip'),
  doc: T('DOC', 'document', ['doc', 'dot'], 'application/msword'),
  xls: T('XLS', 'document', ['xls', 'xlt'], 'application/vnd.ms-excel'),
  ppt: T('PPT', 'document', ['ppt', 'pps', 'pot'], 'application/vnd.ms-powerpoint'),
  ole: T('Office 97–2003', 'document', ['doc', 'xls', 'ppt', 'msg', 'vsd', 'pub'], 'application/x-ole-storage'),
  ole_macro: T('Office 97–2003 (macros)', 'document', ['doc', 'xls', 'ppt'], 'application/x-ole-storage', { dangerous: 'macro' }),
  rtf: T('RTF', 'document', ['rtf'], 'application/rtf'),
  // text
  text: T('TXT', 'text', ['txt', 'csv', 'tsv', 'md', 'markdown', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'tex', 'rst', 'sql', 'css', 'srt', 'sub', 'nfo', 'py', 'c', 'h', 'cpp', 'java', 'kt', 'go', 'rs', 'php', 'rb', 'ts', 'lua', 'r', 'swift', 'cs', 'env', 'properties', 'gitignore'], 'text/plain'),
  html: T('HTML', 'text', ['html', 'htm', 'xhtml'], 'text/html'),
  xml: T('XML', 'text', ['xml', 'xsl', 'xsd', 'rss', 'plist', 'kml', 'gpx'], 'application/xml'),
  json: T('JSON', 'text', ['json', 'geojson', 'jsonl'], 'application/json'),
  vtt: T('WebVTT', 'text', ['vtt'], 'text/vtt'),
  srt: T('SRT', 'text', ['srt'], 'application/x-subrip'),
  // archives
  zip: T('ZIP', 'archive', ['zip'], 'application/zip'),
  tar: T('TAR', 'archive', ['tar'], 'application/x-tar'),
  gzip: T('GZIP', 'archive', ['gz', 'tgz'], 'application/gzip'),
  bz2: T('BZIP2', 'archive', ['bz2', 'tbz2'], 'application/x-bzip2'),
  xz: T('XZ', 'archive', ['xz', 'txz'], 'application/x-xz'),
  zstd: T('ZSTD', 'archive', ['zst'], 'application/zstd'),
  '7z': T('7Z', 'archive', ['7z'], 'application/x-7z-compressed'),
  rar: T('RAR', 'archive', ['rar'], 'application/vnd.rar'),
  // audio
  mp3: T('MP3', 'audio', ['mp3'], 'audio/mpeg'),
  aac: T('AAC', 'audio', ['aac'], 'audio/aac'),
  m4a: T('M4A', 'audio', ['m4a', 'm4b', 'mp4'], 'audio/mp4'),
  wav: T('WAV', 'audio', ['wav'], 'audio/wav'),
  flac: T('FLAC', 'audio', ['flac'], 'audio/flac'),
  opus: T('OGG (Opus)', 'audio', ['ogg', 'opus', 'oga'], 'audio/ogg'),
  vorbis: T('OGG (Vorbis)', 'audio', ['ogg', 'oga'], 'audio/ogg'),
  amr: T('AMR', 'audio', ['amr'], 'audio/amr'),
  midi: T('MIDI', 'audio', ['mid', 'midi'], 'audio/midi'),
  // video
  mp4: T('MP4', 'video', ['mp4', 'm4v'], 'video/mp4'),
  mov: T('MOV', 'video', ['mov', 'qt'], 'video/quicktime'),
  webm: T('WEBM', 'video', ['webm'], 'video/webm'),
  mkv: T('MKV', 'video', ['mkv', 'mka', 'mks'], 'video/x-matroska'),
  avi: T('AVI', 'video', ['avi'], 'video/x-msvideo'),
  '3gp': T('3GP', 'video', ['3gp', '3g2'], 'video/3gpp'),
  ogv: T('OGG (Theora)', 'video', ['ogv', 'ogg'], 'video/ogg'),
  flv: T('FLV', 'video', ['flv'], 'video/x-flv'),
  asf: T('WMV / WMA', 'video', ['wmv', 'wma', 'asf'], 'video/x-ms-asf'),
  // fonts and data
  ttf: T('TTF', 'font', ['ttf'], 'font/ttf'),
  otf: T('OTF', 'font', ['otf'], 'font/otf'),
  woff: T('WOFF', 'font', ['woff'], 'font/woff'),
  woff2: T('WOFF2', 'font', ['woff2'], 'font/woff2'),
  sqlite: T('SQLite', 'data', ['sqlite', 'db', 'sqlite3'], 'application/vnd.sqlite3'),
  // executables and scripts: reported only
  exe: T('Windows executable (PE)', 'executable', ['exe', 'dll', 'scr', 'sys', 'com'], 'application/vnd.microsoft.portable-executable', { dangerous: 'executable' }),
  elf: T('Linux executable (ELF)', 'executable', ['elf', 'so', 'bin', 'out'], 'application/x-elf', { dangerous: 'executable' }),
  macho: T('macOS executable (Mach-O)', 'executable', ['dylib', 'bundle', 'macho'], 'application/x-mach-binary', { dangerous: 'executable' }),
  apk: T('Android app (APK)', 'executable', ['apk'], 'application/vnd.android.package-archive', { dangerous: 'executable' }),
  jar: T('Java archive (JAR)', 'executable', ['jar'], 'application/java-archive', { dangerous: 'executable' }),
  dex: T('Android DEX', 'executable', ['dex'], 'application/x-dex', { dangerous: 'executable' }),
  javaclass: T('Java class', 'executable', ['class'], 'application/java-vm', { dangerous: 'executable' }),
  msi: T('Windows installer (MSI)', 'executable', ['msi'], 'application/x-msi', { dangerous: 'executable' }),
  lnk: T('Windows shortcut (LNK)', 'executable', ['lnk'], 'application/x-ms-shortcut', { dangerous: 'executable' }),
  script: T('Script', 'executable', ['sh', 'bat', 'cmd', 'ps1', 'vbs', 'js'], 'text/plain', { dangerous: 'script' }),
  // nothing recognized
  empty: T('Empty file', 'unknown', [], 'application/octet-stream'),
  unknown: T('Unknown', 'unknown', [], 'application/octet-stream'),
};

/** Extensions that run code when opened (spec §6 + common Windows/macOS ones). */
export const SCRIPT_EXTS = new Set(['bat', 'cmd', 'ps1', 'psm1', 'sh', 'bash', 'zsh', 'command', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'hta', 'reg', 'scr', 'pif', 'cpl', 'msc', 'inf', 'url', 'desktop', 'applescript', 'scpt']);
export const EXEC_EXTS = new Set(['exe', 'dll', 'com', 'msi', 'msp', 'apk', 'xapk', 'jar', 'dex', 'class', 'lnk', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'elf', 'so', 'dylib', 'sys', 'drv', 'ocx', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'xlam', 'ppam']);

export const isDangerousExt = (ext) => SCRIPT_EXTS.has(ext) || EXEC_EXTS.has(ext);
