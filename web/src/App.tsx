import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './pages/Login';
import Register from './pages/Register';

function LoadingScreen() {
  return <div className="app-loading">Loading…</div>;
}

// Guards a route behind an active session, redirecting to /login otherwise.
// Task 7 wires up the real /, /chat/:id, /story/:userId and /settings
// screens; this file's job is the shell + the guard.
function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Keeps an already-signed-in user off the login/register forms.
function RedirectIfAuthed({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

// Placeholder for the chat list + story ring (Task 7).
function HomePlaceholder() {
  const { user } = useAuth();
  return (
    <div className="placeholder-page">
      <h1>Lazybutts</h1>
      <p>Signed in as {user?.username}. The chat list arrives in Task 7.</p>
    </div>
  );
}

// Placeholder for the media_mode toggle / logout / admin invite screen
// (Task 7).
function SettingsPlaceholder() {
  return (
    <div className="placeholder-page">
      <h1>Settings</h1>
      <p>Settings arrive in Task 7.</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <Login />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/register"
            element={
              <RedirectIfAuthed>
                <Register />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePlaceholder />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPlaceholder />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
