import React, { useEffect, useState } from 'react';
import { api } from '../api';
import TopBar from '../components/TopBar';
import { useAuth } from '../App';

const SAMPLE = [
  {
    venueId: 'v_custom_001',
    destination: 'Lisbon, Portugal',
    name: 'Miradouro Wine Bar',
    category: 'food',
    pricePerPerson: 24,
    dietaryTags: ['vegetarian', 'gluten-free'],
    coordinates: { lat: 38.7153, lng: -9.1442 },
    hours: { open: '17:00', close: '23:00' },
    rating: 4.5,
    description: 'Small wine bar with vegetarian petiscos and a terrace over the city.',
    tags: ['wine', 'romantic', 'viewpoint'],
  },
];

export default function Admin() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [venues, setVenues] = useState([]);
  const [payload, setPayload] = useState(JSON.stringify(SAMPLE, null, 2));
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  async function load() {
    const [statsData, venueData] = await Promise.all([
      api.get('/api/v1/admin/dataset-stats'),
      api.get('/api/v1/admin/venues'),
    ]);
    setStats(statsData);
    setVenues(venueData.venues);
  }

  useEffect(() => {
    if (user?.globalRole === 'admin') load().catch((err) => setNotice({ kind: 'error', message: err.message }));
  }, [user]);

  if (user?.globalRole !== 'admin') {
    return (
      <>
        <TopBar />
        <div className="page">
          <div className="card">
            <h2>Admin only</h2>
            <p className="card-sub" style={{ marginTop: 6 }}>
              Venue dataset management requires the Admin role. Sign in as <span className="mono">admin@demo.dev</span>.
            </p>
          </div>
        </div>
      </>
    );
  }

  async function upload(event) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    setResult(null);
    try {
      const parsed = JSON.parse(payload);
      const response = await api.post('/api/v1/admin/venues', Array.isArray(parsed) ? parsed : parsed.venues);
      setResult(response);
      setNotice({ kind: 'ok', message: `Dataset accepted: ${response.accepted} venue(s).` });
      load();
    } catch (err) {
      if (err.details && Array.isArray(err.details)) {
        setErrors(err.details);
        setNotice({ kind: 'error', message: err.message });
      } else if (err instanceof SyntaxError) {
        setNotice({ kind: 'error', message: `Invalid JSON: ${err.message}` });
      } else {
        setNotice({ kind: 'error', message: err.message });
      }
    } finally {
      setBusy(false);
    }
  }

  function loadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPayload(String(reader.result));
    reader.readAsText(file);
  }

  return (
    <>
      <TopBar />
      <div className="page stack">
        <div className="hero" style={{ alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: 22 }}>Venue datasets</h1>
            <p className="card-sub" style={{ marginTop: 4 }}>
              Upload authored venue, lodging and transit metadata. Every record is validated — price, dietary
              vocabulary, coordinates, hours and description — before it reaches the catalog.
            </p>
          </div>
          <span className="chip warn">admin</span>
        </div>

        {notice && <div className={notice.kind === 'ok' ? 'form-ok' : 'form-error'}>{notice.message}</div>}

        <div className="grid-2" style={{ gridTemplateColumns: '1.1fr 1fr' }}>
          <section className="card stack-sm">
            <div className="row-between">
              <span className="card-title">Upload dataset</span>
              <span className="tiny muted">JSON array of venues</span>
            </div>
            <form className="stack" onSubmit={upload}>
              <textarea
                className="input mono"
                style={{ minHeight: 280, fontSize: 12 }}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                spellCheck={false}
              />
              <div className="row wrap" style={{ gap: 8 }}>
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                  Load .json file
                  <input type="file" accept="application/json,.json" onChange={loadFile} hidden />
                </label>
                <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
                  {busy ? 'Validating…' : 'Validate & upload'}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPayload(JSON.stringify(SAMPLE, null, 2))}>
                  Reset sample
                </button>
              </div>
            </form>

            {errors.length > 0 && (
              <div className="stack-sm">
                <span className="card-title" style={{ color: 'var(--danger)' }}>Rejected records</span>
                {errors.map((error, index) => (
                  <p key={`${error.field}-${index}`} className="tiny" style={{ color: '#fca5a5' }}>
                    #{error.index ?? '-'} · <strong>{error.field}</strong>: {error.message}
                  </p>
                ))}
              </div>
            )}
            {result && (
              <div className="form-ok tiny">
                Accepted {result.accepted} · inserted {result.inserted} · updated {result.updated} · destinations: {result.destinations.join(', ')}
              </div>
            )}
          </section>

          <section className="stack">
            <div className="card stack-sm">
              <span className="card-title">Coverage</span>
              {!stats && <div className="spinner" />}
              {stats?.destinations.map((destination) => (
                <div key={destination.destinationSlug} className="card-flat stack-sm">
                  <div className="row-between">
                    <strong style={{ fontSize: 13 }}>{destination.destination}</strong>
                    <span className="tiny muted">{destination.venues} venues</span>
                  </div>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {destination.categories.map((category) => <span key={category} className="tag">{category}</span>)}
                  </div>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {destination.dietaryTags.map((tag) => <span key={tag} className="tag veg">{tag}</span>)}
                  </div>
                  <p className="tiny muted">
                    ${(destination.minPriceCents / 100).toFixed(0)} – ${(destination.maxPriceCents / 100).toFixed(0)} per person
                  </p>
                </div>
              ))}
            </div>

            <div className="card stack-sm">
              <div className="row-between">
                <span className="card-title">Catalog</span>
                <span className="tiny muted">{venues.length} records</span>
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Venue</th><th>Category</th><th>Price</th></tr></thead>
                  <tbody>
                    {venues.map((venue) => (
                      <tr key={`${venue.venueId}-${venue.name}`}>
                        <td>
                          {venue.name}
                          <span className="tiny mono muted" style={{ display: 'block' }}>{venue.venueId}</span>
                        </td>
                        <td>{venue.category}</td>
                        <td>${venue.pricePerPersonCents / 100}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
