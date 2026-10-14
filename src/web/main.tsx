// Mount the React UI into the Vite HTML shell.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BRAND } from '../core/brand.js';
import { App } from './App.js';
import './styles.css';

document.title = BRAND.displayName;
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
