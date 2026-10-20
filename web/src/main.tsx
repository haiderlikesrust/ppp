import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import '@fontsource-variable/inter';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
