import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';

const DEMO = [
  { email: 'arun@demo.dev', label: 'Arun — Trip Leader' },
  { email: 'maya@demo.dev', label: 'Maya — Planner' },
  { email: 'leo@demo.dev', label: 'Leo — Viewer' },
  { email: 'admin@demo.dev', label: 'Admin — datasets' },
];

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('arun@demo.dev');
  const [password, setPassword] = useState('Demo1234!');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(email.trim(), password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-art">
        <div className="row" style={{ gap: 10 }}>
          <div className="brand-mark">▲</div>
          <div className="brand">Trip War Room</div>
        </div>
        <div>
          <h1>Plan the trip together. In real time. With an AI that has receipts.</h1>
          <p>
            One shared canvas for the whole group: pin lodgings and activities, watch the budget recalculate,
            settle contested slots with a timed vote, and ask the concierge for a dinner spot that actually fits
            everyone's budget, diet and schedule.
          </p>
          <div className="auth-bullets">
            <div className="auth-bullet"><span>◆</span><span>Live multiplayer board with sub-100ms sync and conflict-safe moves</span></div>
            <div className="auth-bullet"><span>◆</span><span>Hard-constraint AI: budget ceiling, dietary tags, opening hours, radius</span></div>
            <div className="auth-bullet"><span>◆</span><span>Exact integer-cent budget splits — even or weighted, never an approximation</span></div>
            <div className="auth-bullet"><span>◆</span><span>Grounded answers that cite the venue records they came from</span></div>
          </div>
        </div>
        <p className="tiny" style={{ color: '#7f8ea3' }}>React · Express · Socket.io · MongoDB · JWT · RBAC</p>
      </div>

      <div className="auth-form">
        <div className="auth-card stack">
          <div>
            <h2 style={{ fontSize: 22 }}>Welcome back</h2>
            <p className="card-sub" style={{ marginTop: 4 }}>Sign in to your Trip War Room.</p>
          </div>

          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" value={email} autoComplete="username"
                onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" value={password} autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="tiny muted center">
            New here? <Link to="/register">Create an account</Link>
          </p>

          <div className="demo-accounts stack-sm">
            <p className="tiny muted">Demo accounts (password <code>Demo1234!</code>)</p>
            {DEMO.map((account) => (
              <button
                key={account.email}
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ justifyContent: 'space-between' }}
                onClick={() => {
                  setEmail(account.email);
                  setPassword('Demo1234!');
                }}
              >
                <span>{account.label}</span>
                <span className="mono tiny muted">{account.email}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
