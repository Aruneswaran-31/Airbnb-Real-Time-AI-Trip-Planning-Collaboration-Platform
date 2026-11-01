import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../App';

export default function TopBar({ children }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const initials = (user?.displayName || '?')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  async function logout() {
    try {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('twr.accessToken')}` },
      });
    } catch {
      /* best effort */
    }
    signOut();
  }

  return (
    <header className="topbar">
      <button
        className="brand"
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
        onClick={() => navigate('/')}
      >
        <span className="brand-mark">▲</span>
        <span>Trip War Room</span>
      </button>

      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>Dashboard</NavLink>
        {user?.globalRole === 'admin' && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>Datasets</NavLink>
        )}
      </nav>

      <div className="grow" />
      {children}
      <div className="row" style={{ gap: 8 }}>
        <span className={`chip ${user?.globalRole === 'admin' ? 'warn' : ''}`}>
          {user?.globalRole === 'admin' ? 'admin' : user?.globalRole}
        </span>
        <div className="avatar" title={user?.displayName}>{initials}</div>
        <button className="btn btn-sm btn-ghost" onClick={logout}>Sign out</button>
      </div>
    </header>
  );
}
