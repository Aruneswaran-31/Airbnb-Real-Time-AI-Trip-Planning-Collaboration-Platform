import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import TopBar from '../components/TopBar';
import { useAuth } from '../App';

function money(cents, currency = 'USD') {
  const value = (cents || 0) / 100;
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: value % 1 === 0 ? 0 : 2 })}`;
}

function formatDateRange(start, end) {
  if (!start || !end) return '';
  const options = { month: 'short', day: 'numeric' };
  return `${new Date(`${start}T00:00:00Z`).toLocaleDateString(undefined, options)} – ${new Date(`${end}T00:00:00Z`).toLocaleDateString(undefined, { ...options, year: 'numeric' })}`;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" style={wide ? { maxWidth: 780 } : undefined}>
        <div className="row-between" style={{ marginBottom: 14 }}>
          <h3>{title}</h3>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [destinations, setDestinations] = useState([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null); // 'create' | 'join' | 'analytics'
  const [analytics, setAnalytics] = useState(null);
  const [busy, setBusy] = useState(false);

  const [createForm, setCreateForm] = useState({
    destination: '',
    startDate: '',
    endDate: '',
    totalBudget: 2400,
    maxParticipants: 6,
  });
  const [joinCode, setJoinCode] = useState('');

  function flash(message, kind = 'ok') {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3600);
  }

  async function load() {
    try {
      const [dashboard, catalog] = await Promise.all([
        api.get('/api/v1/dashboard'),
        api.get('/api/v1/destinations'),
      ]);
      setData(dashboard);
      setDestinations(catalog.destinations);
      setCreateForm((current) => ({
        ...current,
        destination: current.destination || catalog.destinations[0]?.destination || '',
        startDate: current.startDate || new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
        endDate: current.endDate || new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10),
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const activeTrips = data?.trips.active || [];
  const pastTrips = data?.trips.past || [];

  const totals = useMemo(() => {
    if (!data) return null;
    const counted = [...activeTrips, ...pastTrips];
    const planned = counted.reduce((sum, trip) => sum + trip.groupSpendCents, 0);
    return { planned, count: counted.length };
  }, [data, activeTrips, pastTrips]);

  async function createTrip(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const trip = await api.post('/api/v1/trips', {
        destination: createForm.destination,
        startDate: createForm.startDate,
        endDate: createForm.endDate,
        totalBudget: Number(createForm.totalBudget),
        maxParticipants: Number(createForm.maxParticipants),
      });
      navigate(`/trips/${trip.tripId}`);
    } catch (err) {
      flash(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function joinTrip(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post('/api/v1/trips/join', { inviteCode: joinCode.trim() });
      navigate(`/trips/${result.tripId}`);
    } catch (err) {
      flash(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openAnalytics(tripId) {
    setModal('analytics');
    setAnalytics(null);
    try {
      const result = await api.get(`/api/v1/trips/${tripId}/analytics`);
      setAnalytics(result.analytics);
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function likeVenue(venueId) {
    try {
      await api.post('/api/v1/recommendations/feedback', { venueId, liked: true });
      flash('Saved to your taste profile — the rail will adapt.');
      load();
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  if (error) {
    return (
      <>
        <TopBar />
        <div className="page"><div className="form-error">{error}</div></div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <TopBar />
        <div className="app-loading"><div className="spinner" /><p>Loading your trips…</p></div>
      </>
    );
  }

  return (
    <>
      <TopBar>
        <button className="btn btn-sm btn-teal" onClick={() => setModal('join')}>Join with code</button>
        <button className="btn btn-sm btn-primary" onClick={() => setModal('create')}>New trip room</button>
      </TopBar>

      <div className="page stack" style={{ gap: 18 }}>
        <section className="hero">
          <div>
            <p className="tiny muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <h1 style={{ marginTop: 4 }}>Welcome back, {user?.displayName?.split(' ')[0]}</h1>
            <p className="card-sub" style={{ marginTop: 6 }}>
              {activeTrips.length
                ? `${activeTrips.length} live room${activeTrips.length > 1 ? 's' : ''} · ${money(totals.planned)} committed across ${totals.count} trips`
                : 'No live rooms yet — create one and invite your group.'}
            </p>
          </div>
          <div className="row wrap" style={{ gap: 20 }}>
            <div className="stat"><span className="stat-value">{data.stats.activeTrips}</span><span className="stat-label">Live rooms</span></div>
            <div className="stat"><span className="stat-value">{data.stats.destinations}</span><span className="stat-label">Destinations</span></div>
            <div className="stat"><span className="stat-value">{data.stats.aiQuestionsAsked}</span><span className="stat-label">AI questions</span></div>
            <div className="stat"><span className="stat-value">{data.stats.votesRun}</span><span className="stat-label">Votes</span></div>
          </div>
        </section>

        <div className="grid-2" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
          <section className="stack">
            <div className="row-between">
              <h2 style={{ fontSize: 16 }}>Live rooms</h2>
              <span className="tiny muted">Real-time canvas · budget · votes</span>
            </div>

            {activeTrips.length === 0 && <div className="empty">No live rooms. Create one to start planning.</div>}

            {activeTrips.map((trip) => {
              const utilisation = trip.totalBudgetCents ? Math.round((trip.groupSpendCents / trip.totalBudgetCents) * 100) : 0;
              return (
                <article key={trip.tripId} className="trip-card">
                  <div className="row-between">
                    <div>
                      <h3>{trip.destination}</h3>
                      <p className="tiny muted">{formatDateRange(trip.startDate, trip.endDate)} · invite <span className="mono">{trip.inviteCode}</span></p>
                    </div>
                    <span className={`chip ${trip.role === 'leader' ? 'warn' : ''}`}>{trip.role}</span>
                  </div>

                  <div className="meter" title={`${utilisation}% of budget`}>
                    <span style={{ width: `${Math.min(100, utilisation)}%` }} />
                  </div>
                  <div className="row-between tiny muted">
                    <span>{trip.participants} traveler{trip.participants > 1 ? 's' : ''} · {trip.itemCount} items</span>
                    <span>{money(trip.groupSpendCents)} of {money(trip.totalBudgetCents)}</span>
                  </div>

                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => navigate(`/trips/${trip.tripId}`)}>Open room</button>
                    <button className="btn btn-sm" onClick={() => openAnalytics(trip.tripId)}>Analytics</button>
                  </div>
                </article>
              );
            })}

            <div className="row-between" style={{ marginTop: 6 }}>
              <h2 style={{ fontSize: 16 }}>Trip history</h2>
              <span className="tiny muted">{pastTrips.length} completed</span>
            </div>
            {pastTrips.length === 0 ? (
              <div className="empty">Completed trips land here with their final budget breakdown.</div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="table">
                  <thead>
                    <tr><th>Destination</th><th>Dates</th><th>Travelers</th><th>Spend</th><th /></tr>
                  </thead>
                  <tbody>
                    {pastTrips.map((trip) => (
                      <tr key={trip.tripId}>
                        <td>{trip.destination}</td>
                        <td className="muted">{formatDateRange(trip.startDate, trip.endDate)}</td>
                        <td>{trip.participants}</td>
                        <td>{money(trip.groupSpendCents)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-sm btn-ghost" onClick={() => openAnalytics(trip.tripId)}>Report</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="stack">
            <div className="card stack-sm">
              <div className="row-between">
                <span className="card-title">Your travel profile</span>
                <button className="btn btn-sm btn-ghost" onClick={() => navigate('/admin')} hidden={user?.globalRole !== 'admin'}>Manage</button>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {(data.preferenceProfile.dietaryTags || []).length
                  ? data.preferenceProfile.dietaryTags.map((tag) => <span key={tag} className="tag veg">{tag}</span>)
                  : <span className="tiny muted">No dietary constraints declared.</span>}
              </div>
              <div className="stack-sm" style={{ marginTop: 4 }}>
                {data.preferenceProfile.favoriteCategories.map((entry) => (
                  <div key={entry.category} className="cat-row">
                    <span className="muted">{entry.category}</span>
                    <div className="cat-bar"><span style={{ width: `${entry.affinity}%` }} /></div>
                    <span className="tiny muted" style={{ textAlign: 'right' }}>{entry.affinity}%</span>
                  </div>
                ))}
                {data.preferenceProfile.favoriteCategories.length === 0 && (
                  <p className="tiny muted">Pin or save venues and your affinity profile builds itself.</p>
                )}
              </div>
              <p className="tiny muted" style={{ marginTop: 4 }}>
                Per-person ceiling {money(data.preferenceProfile.maxPerPersonBudgetCents || 0)}
              </p>
            </div>

            <div className="card stack-sm">
              <div className="row-between">
                <span className="card-title">Recommended for you</span>
                <span className="tiny muted">{data.recommendationSignals?.scopedTo}</span>
              </div>
              {data.recommendations.length === 0 && <p className="tiny muted">Save a few venues to unlock the rail.</p>}
              {data.recommendations.map((item) => (
                <div key={item.venueId} className="card-flat stack-sm" style={{ gap: 5 }}>
                  <div className="row-between" style={{ alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                      <div className="tiny muted">{item.category} · {item.rating}★</div>
                    </div>
                    <span className="tiny nowrap" style={{ color: 'var(--teal)', fontWeight: 650 }}>{money(item.pricePerPersonCents)}</span>
                  </div>
                  <div className="rail-reasons">
                    {item.reasons.slice(0, 2).map((reason) => <span key={reason} className="reason">{reason}</span>)}
                  </div>
                  <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => likeVenue(item.venueId)}>
                    ♥ Save
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      {modal === 'create' && (
        <Modal title="New trip room" onClose={() => setModal(null)}>
          <form className="stack" onSubmit={createTrip}>
            <div className="field">
              <label>Destination (loaded datasets)</label>
              <select className="input" value={createForm.destination}
                onChange={(e) => setCreateForm({ ...createForm, destination: e.target.value })}>
                {destinations.map((destination) => (
                  <option key={destination.destinationSlug} value={destination.destination}>
                    {destination.destination} — {destination.venueCount} venues
                  </option>
                ))}
              </select>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>Start date</label>
                <input className="input" type="date" value={createForm.startDate}
                  onChange={(e) => setCreateForm({ ...createForm, startDate: e.target.value })} required />
              </div>
              <div className="field grow">
                <label>End date</label>
                <input className="input" type="date" value={createForm.endDate}
                  onChange={(e) => setCreateForm({ ...createForm, endDate: e.target.value })} required />
              </div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>Total group budget (USD)</label>
                <input className="input" type="number" min="1" step="50" value={createForm.totalBudget}
                  onChange={(e) => setCreateForm({ ...createForm, totalBudget: e.target.value })} required />
              </div>
              <div className="field grow">
                <label>Max travelers</label>
                <input className="input" type="number" min="2" max="50" value={createForm.maxParticipants}
                  onChange={(e) => setCreateForm({ ...createForm, maxParticipants: e.target.value })} required />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </form>
        </Modal>
      )}

      {modal === 'join' && (
        <Modal title="Join a trip room" onClose={() => setModal(null)}>
          <form className="stack" onSubmit={joinTrip}>
            <div className="field">
              <label>Invite code</label>
              <input className="input mono" placeholder="AB-7Q2K" value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())} required />
              <p className="tiny muted">Ask the Trip Leader for the code shown in their room header.</p>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>Join room</button>
          </form>
        </Modal>
      )}

      {modal === 'analytics' && (
        <Modal title="Session analytics" onClose={() => setModal(null)} wide>
          {!analytics ? (
            <div className="app-loading" style={{ height: 160 }}><div className="spinner" /></div>
          ) : (
            <div className="stack">
              <div className="grid-4">
                <div className="card-flat"><div className="stat-label">Planning time</div><div className="stat-value">{(analytics.planningDurationMs / 3600000).toFixed(1)}h</div></div>
                <div className="card-flat"><div className="stat-label">Peak planners</div><div className="stat-value">{analytics.peakConcurrentPlanners}</div></div>
                <div className="card-flat"><div className="stat-label">AI questions</div><div className="stat-value">{analytics.aiQuestionsAsked}</div></div>
                <div className="card-flat"><div className="stat-label">Conflicts</div><div className="stat-value">{analytics.conflictsFlagged}</div></div>
              </div>

              <div className="card-flat">
                <div className="row-between">
                  <span className="card-title">Budget reconciliation</span>
                  <span className={`chip ${analytics.reconciliation.matches ? 'live' : 'danger'}`}>
                    {analytics.reconciliation.matches ? 'event log matches board' : `delta ${money(analytics.reconciliation.deltaCents)}`}
                  </span>
                </div>
                <div className="stack-sm" style={{ marginTop: 8 }}>
                  {analytics.finalPerPersonBreakdown.map((person) => (
                    <div key={person.userId} className={`person-row ${person.overCeiling ? 'over' : ''}`}>
                      <span>{person.name}{person.overCeiling ? ' · over ceiling' : ''}</span>
                      <span>{money(person.shareCents)}</span>
                    </div>
                  ))}
                  <div className="person-row" style={{ fontWeight: 700 }}>
                    <span>Group total</span>
                    <span>{money(analytics.budget.groupTotalCents)}</span>
                  </div>
                </div>
              </div>

              <table className="table">
                <thead><tr><th>Event</th><th>Count</th></tr></thead>
                <tbody>
                  <tr><td>Items pinned</td><td>{analytics.itemsPinned}</td></tr>
                  <tr><td>Items moved</td><td>{analytics.itemsMoved}</td></tr>
                  <tr><td>Votes opened</td><td>{analytics.votesOpened}</td></tr>
                  <tr><td>Votes resolved</td><td>{analytics.votesResolved}</td></tr>
                  <tr><td>Conflicts flagged</td><td>{analytics.conflictsFlagged}</td></tr>
                  <tr><td>Conflicts resolved</td><td>{analytics.conflictsResolved}</td></tr>
                  <tr><td>Chat messages</td><td>{analytics.chatMessages}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </>
  );
}
