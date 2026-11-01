import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';

const DIETARY = ['vegetarian', 'vegan', 'halal', 'gluten-free', 'nut-free', 'dairy-free', 'pescatarian'];

export default function Register() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [dietaryTags, setDietaryTags] = useState([]);
  const [viewer, setViewer] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggleTag(tag) {
    setDietaryTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signUp({
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        password: form.password,
        dietaryTags,
        globalRole: viewer ? 'viewer' : 'planner',
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not create the account');
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
          <h1>Your group's plan, finally in one live place.</h1>
          <p>
            Create a room, share the invite code, and let the group build the itinerary together. Your dietary
            tags and budget ceiling travel with you, so the concierge never suggests something you cannot eat or afford.
          </p>
          <div className="auth-bullets">
            <div className="auth-bullet"><span>◆</span><span>Viewers can watch and vote; planners can pin and move</span></div>
            <div className="auth-bullet"><span>◆</span><span>Leaders lock finalized items and moderate the room</span></div>
            <div className="auth-bullet"><span>◆</span><span>Every conflict is flagged the moment it appears</span></div>
          </div>
        </div>
        <p className="tiny" style={{ color: '#7f8ea3' }}>No payment data, ever. Budget tracking is arithmetic only.</p>
      </div>

      <div className="auth-form">
        <div className="auth-card stack">
          <div>
            <h2 style={{ fontSize: 22 }}>Create your account</h2>
            <p className="card-sub" style={{ marginTop: 4 }}>Takes a few seconds. No email verification in this build.</p>
          </div>

          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label htmlFor="name">Display name</label>
              <input id="name" className="input" value={form.displayName} required minLength={2}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Maya" />
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" value={form.email} required autoComplete="username"
                onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
            </div>
            <div className="field">
              <label htmlFor="password">Password (min 8 characters)</label>
              <input id="password" className="input" type="password" value={form.password} required minLength={8}
                autoComplete="new-password" onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>

            <div className="field">
              <label>Dietary constraints</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {DIETARY.map((tag) => (
                  <button key={tag} type="button" className={`btn btn-sm ${dietaryTags.includes(tag) ? 'btn-teal' : 'btn-ghost'}`}
                    onClick={() => toggleTag(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
              <p className="tiny muted">These are enforced by the AI concierge for every suggestion it makes for your group.</p>
            </div>

            <label className="check">
              <input type="checkbox" checked={viewer} onChange={(e) => setViewer(e.target.checked)} />
              Join as a viewer (read-only, can still vote and chat)
            </label>

            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>

          <p className="tiny muted center">
            Already have one? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
