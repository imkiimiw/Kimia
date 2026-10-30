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
import { initTelegram } from './tg';

initTelegram();
render(<App />, document.getElementById('app')!);
