import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import './index.css';

// AuthProvider sits OUTSIDE the router. It patches fetch for the whole app and
// decides between the login screen and the routes, and neither of those is a
// routing concern — inside the router it would also be remounted by navigation
// and re-run the session check on every page change.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
