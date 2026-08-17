import React from 'react';
import { createRoot } from 'react-dom/client';
import Approval from './Approval.jsx';
import '../lib/styles.css';

document.body.classList.add('approval');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Approval />
  </React.StrictMode>
);
