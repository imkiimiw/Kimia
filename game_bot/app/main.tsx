import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/vazirmatn/400.css';
import '@fontsource/vazirmatn/600.css';
import '@fontsource/vazirmatn/800.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/games.css';
import { render } from 'preact';
import { App } from './App';
import { initTelegram, logEvent } from './tg';

initTelegram();
window.addEventListener('error', (e) => logEvent('js-error', { msg: String(e.message).slice(0, 160), at: `${String(e.filename || '').split('/').pop()}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => logEvent('js-reject', { msg: String((e.reason && e.reason.message) || e.reason).slice(0, 160) }));
render(<App />, document.getElementById('app')!);
