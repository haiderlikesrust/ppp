import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import '@fontsource-variable/outfit';
import '@fontsource-variable/figtree';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
