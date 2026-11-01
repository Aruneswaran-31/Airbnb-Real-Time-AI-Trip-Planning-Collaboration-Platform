import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, tokenStore } from '../api';
import { createTripSocket, emitAsync } from '../socket';
import TopBar from '../components/TopBar';
import { useAuth } from '../App';

function money(cents, currency = 'USD') {
  const value = (cents || 0) / 100;
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: value % 1 === 0 ? 0 : 2 })}`;
}

function dayLabel(trip, dayIndex) {
  const base = new Date(`${trip.startDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayIndex);
  return {
    title: `Day ${dayIndex + 1}`,
    date: base.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

function dayCount(trip) {
  const start = new Date(`${trip.startDate}T00:00:00Z`).getTime();
  const end = new Date(`${trip.endDate}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

const TIME_SLOTS = Array.from({ length: 30 }, (_, i) => {
  const minutes = 7 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function TripRoom() {
  const { tripId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [connected, setConnected] = useState(false);
  const [driftMs, setDriftMs] = useState(null);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [conflictNotice, setConflictNotice] = useState(null);
  const [tab, setTab] = useState('budget');
  const [chatDraft, setChatDraft] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnchor, setAiAnchor] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLatest, setAiLatest] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [pinForm, setPinForm] = useState({ venueId: '', dayIndex: 0, startTime: '10:00', durationMinutes: 90 });
  const [moveOpen, setMoveOpen] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverDay, setDragOverDay] = useState(null);

  const socketRef = useRef(null);
  const chatEndRef = useRef(null);
  const typingTimerRef = useRef(null);

  function flash(message, kind = 'ok') {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 4200);
  }

  const applySnapshot = useCallback((snapshot) => {
    setBoard({
      trip: snapshot.trip,
      role: snapshot.role,
      members: snapshot.members,
      items: snapshot.items,
      budget: snapshot.budget,
      conflicts: snapshot.conflicts,
      votes: snapshot.votes,
      presence: snapshot.presence || [],
      leaderState: snapshot.leaderState || { online: true, frozen: false },
    });
  }, []);

  /** Initial load + chat history, then connect the socket. */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [boardData, chatData] = await Promise.all([
          api.get(`/api/v1/trips/${tripId}/board`),
          api.get(`/api/v1/trips/${tripId}/chat`),
        ]);
        if (cancelled) return;
        applySnapshot(boardData);
        setMessages(chatData.messages);
        const catalogData = await api.get(
          `/api/v1/destinations/${encodeURIComponent(boardData.trip.destination)}/venues`
        );
        if (!cancelled) {
          setCatalog(catalogData.venues);
          setPinForm((current) => ({ ...current, venueId: catalogData.venues[0]?.venueId || '' }));
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [tripId, applySnapshot]);

  useEffect(() => {
    const socket = createTripSocket();
    socketRef.current = socket;

    socket.on('connect', async () => {
      setConnected(true);
      try {
        await emitAsync(socket, 'trip.join', { tripId });
      } catch (err) {
        flash(err.message, 'error');
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      setConnected(false);
      setError(err.message === 'unauthorized' ? 'Session expired — sign in again.' : err.message);
    });

    socket.on('trip.board.snapshot', (msg) => applySnapshot(msg.payload));

    socket.on('trip.board.update', (msg) => {
      setBoard((current) =>
        current
          ? {
              ...current,
              items: msg.payload.items,
              budget: msg.payload.budget,
              conflicts: msg.payload.conflicts,
              votes: (current.votes || []).filter((vote) =>
                (msg.payload.items || []).some((item) => vote.candidateItemIds.map(String).includes(String(item.itemId)))
              ),
            }
          : current
      );
      setDriftMs(msg.payload.serverTime ? Date.now() - msg.ts : null);
    });

    socket.on('trip.board.conflict', (msg) => {
      const payload = msg.payload || {};
      if (payload.conflictType === 'version') {
        setConflictNotice(payload);
        setBoard((current) => {
          if (!current) return current;
          return {
            ...current,
            items: current.items.map((item) =>
              String(item.itemId) === String(payload.itemId) ? { ...payload.currentItem, itemId: payload.itemId } : item
            ),
          };
        });
        flash('Another planner moved that item first — your board was resynced.', 'error');
        return;
      }
      if (payload.status === 'resolved') {
        flash('A conflict was resolved.', 'ok');
      } else {
        flash(payload.details?.message || 'New conflict flagged', 'error');
      }
    });

    socket.on('trip.presence.update', (msg) => {
      setBoard((current) => (current ? { ...current, presence: msg.payload.participants || current.presence } : current));
      if (msg.payload.latencyMs) setDriftMs(msg.payload.latencyMs);
    });

    socket.on('trip.chat.message', (msg) => {
      setMessages((current) =>
        current.some((m) => m.messageId === msg.payload.message.messageId) ? current : [...current, msg.payload.message]
      );
    });

    socket.on('trip.chat.typing', (msg) => {
      const { userId, name, isTyping } = msg.payload;
      setTypingUsers((current) => {
        const others = current.filter((entry) => entry.userId !== userId);
        return isTyping ? [...others, { userId, name }] : others;
      });
    });

    socket.on('trip.chat.reaction', (msg) => {
      setMessages((current) =>
        current.map((message) =>
          message.messageId === msg.payload.messageId ? { ...message, reactions: msg.payload.reactions } : message
        )
      );
    });

    socket.on('trip.vote.open', (msg) => {
      setBoard((current) => (current ? { ...current, votes: [...current.votes.filter((v) => v.voteId !== msg.payload.vote.voteId), msg.payload.vote] } : current));
      flash('A slot vote is open — cast your ballot.');
    });

    socket.on('trip.vote.cast', (msg) => {
      setBoard((current) =>
        current
          ? {
              ...current,
              votes: current.votes.map((vote) =>
                vote.voteId === msg.payload.voteId
                  ? {
                      ...vote,
                      ballots: [
                        ...(vote.ballots || []).filter((b) => String(b.userId) !== String(msg.payload.userId)),
                        { userId: msg.payload.userId, candidateItemId: msg.payload.candidateItemId },
                      ],
                    }
                  : vote
              ),
            }
          : current
      );
    });

    socket.on('trip.vote.resolved', (msg) => {
      setBoard((current) => (current ? { ...current, votes: current.votes.filter((v) => v.voteId !== msg.payload.voteId) } : current));
      flash(msg.payload.cancelled ? 'Vote cancelled.' : 'Vote resolved — the winning option is on the board.');
    });

    socket.on('trip.leader.state', (msg) => {
      setBoard((current) => (current ? { ...current, leaderState: msg.payload } : current));
      if (msg.payload.message) flash(msg.payload.message, msg.payload.frozen ? 'error' : 'ok');
    });

    socket.on('trip.room.settings', (msg) => {
      setBoard((current) =>
        current
          ? {
              ...current,
              trip: {
                ...current.trip,
                roomLocked: msg.payload.roomLocked ?? current.trip.roomLocked,
                totalBudgetCents: msg.payload.totalBudgetCents ?? current.trip.totalBudgetCents,
                maxParticipants: msg.payload.maxParticipants ?? current.trip.maxParticipants,
                status: msg.payload.status ?? current.trip.status,
              },
            }
          : current
      );
    });

    socket.on('trip.error', (msg) => flash(msg.payload.message, 'error'));

    socket.connect();

    const heartbeat = setInterval(() => {
      if (socket.connected) socket.emit('trip.sync.ping', { tripId, payload: { clientSentAt: Date.now() } });
    }, 12000);

    socket.on('trip.sync.pong', (msg) => {
      const payload = msg.payload || {};
      if (payload.clientSentAt) setDriftMs(Date.now() - payload.clientSentAt);
    });

    return () => {
      clearInterval(heartbeat);
      socket.emit('trip.leave', { tripId });
      socket.close();
    };
  }, [tripId, applySnapshot]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, tab]);

  const days = useMemo(() => (board ? Array.from({ length: dayCount(board.trip) }, (_, i) => i) : []), [board]);

  const itemsByDay = useMemo(() => {
    const map = new Map();
    for (const item of board?.items || []) {
      if (!map.has(item.dayIndex)) map.set(item.dayIndex, []);
      map.get(item.dayIndex).push(item);
    }
    for (const list of map.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return map;
  }, [board]);

  const conflictItemIds = useMemo(
    () => new Set((board?.conflicts || []).flatMap((conflict) => conflict.itemIds.map(String))),
    [board]
  );

  const myVotes = useMemo(() => {
    const map = new Map();
    for (const vote of board?.votes || []) {
      const ballot = (vote.ballots || []).find((b) => String(b.userId) === String(user.userId || user.userId));
      if (ballot) map.set(vote.voteId, String(ballot.candidateItemId));
    }
    return map;
  }, [board, user]);

  const canPlan = ['planner', 'leader', 'admin'].includes(board?.role);

  async function sendChat(event) {
    event.preventDefault();
    if (!chatDraft.trim()) return;
    try {
      await emitAsync(socketRef.current, 'trip.chat.send', { tripId, payload: { body: chatDraft.trim() } });
      setChatDraft('');
      socketRef.current.emit('trip.chat.typing', { tripId, payload: { isTyping: false } });
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  function onChatTyping(value) {
    setChatDraft(value);
    socketRef.current?.emit('trip.chat.typing', { tripId, payload: { isTyping: Boolean(value) } });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit('trip.chat.typing', { tripId, payload: { isTyping: false } });
    }, 2200);
  }

  async function pinItem(event) {
    event.preventDefault();
    const startTime = pinForm.startTime;
    const endTime = addMinutes(startTime, Number(pinForm.durationMinutes));
    try {
      await emitAsync(socketRef.current, 'trip.board.pin', {
        tripId,
        payload: {
          venueId: pinForm.venueId,
          dayIndex: Number(pinForm.dayIndex),
          startTime,
          endTime,
        },
      });
      setPinOpen(false);
      flash('Pinned to the canvas.');
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function moveItem(item, dayIndex) {
    try {
      await emitAsync(socketRef.current, 'trip.board.move', {
        tripId,
        payload: {
          itemId: item.itemId,
          dayIndex,
          startTime: item.startTime,
          endTime: item.endTime,
          expectedVersion: item.positionVersion,
        },
      });
    } catch (err) {
      flash(err.code === 'stale_version' ? 'Another planner moved that item first — resynced.' : err.message, 'error');
    }
  }

  async function moveItemToSlot(item, dayIndex, startTime) {
    const duration = (() => {
      const [sh, sm] = item.startTime.split(':').map(Number);
      const [eh, em] = item.endTime.split(':').map(Number);
      return Math.max(30, eh * 60 + em - (sh * 60 + sm));
    })();
    try {
      await emitAsync(socketRef.current, 'trip.board.move', {
        tripId,
        payload: {
          itemId: item.itemId,
          dayIndex,
          startTime,
          endTime: addMinutes(startTime, duration),
          expectedVersion: item.positionVersion,
        },
      });
      setMoveOpen(null);
    } catch (err) {
      flash(err.code === 'stale_version' ? 'Another planner moved that item first — resynced.' : err.message, 'error');
    }
  }

  async function removeItem(item) {
    try {
      await emitAsync(socketRef.current, 'trip.board.remove', { tripId, payload: { itemId: item.itemId } });
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function toggleLock(item) {
    const event = item.lifecycleStage === 'locked' ? 'trip.board.unlock' : 'trip.board.lock';
    try {
      await emitAsync(socketRef.current, event, { tripId, payload: { itemId: item.itemId } });
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function askConcierge(event) {
    event.preventDefault();
    if (!aiQuestion.trim()) return;
    setAiBusy(true);
    setAiLatest(null);
    try {
      const result = await api.post(`/api/v1/trips/${tripId}/ai/ask`, {
        question: aiQuestion.trim(),
        anchorItemId: aiAnchor || undefined,
      });
      setAiLatest(result);
    } catch (err) {
      flash(err.message, 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function openVote(candidateIds) {
    try {
      await api.post(`/api/v1/trips/${tripId}/votes`, { candidateItemIds: candidateIds, closesInSeconds: 120 });
      flash('Slot vote opened for 2 minutes.');
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function castVote(voteId, itemId) {
    try {
      await emitAsync(socketRef.current, 'trip.vote.cast', {
        tripId,
        payload: { voteId, candidateItemId: itemId },
      });
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function resolveVote(voteId) {
    try {
      await emitAsync(socketRef.current, 'trip.vote.resolve', { tripId, payload: { voteId } });
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function lockRoom(next) {
    try {
      await api.patch(`/api/v1/trips/${tripId}`, { roomLocked: next });
      flash(next ? 'Room locked — planners are read-only.' : 'Room unlocked.');
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function transferLeader(userId) {
    if (!userId) return;
    try {
      await api.post(`/api/v1/trips/${tripId}/transfer-leader`, { userId });
      flash('Leader role transferred.');
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  async function completeTrip() {
    try {
      await api.post(`/api/v1/trips/${tripId}/complete`);
      flash('Trip completed and archived.');
      setTimeout(() => navigate('/'), 900);
    } catch (err) {
      flash(err.message, 'error');
    }
  }

  if (error) {
    return (
      <>
        <TopBar />
        <div className="page stack">
          <div className="form-error">{error}</div>
          <button className="btn" onClick={() => navigate('/')}>Back to dashboard</button>
        </div>
      </>
    );
  }

  if (!board) {
    return (
      <>
        <TopBar />
        <div className="app-loading"><div className="spinner" /><p>Syncing the board…</p></div>
      </>
    );
  }

  const { trip, budget, conflicts, votes, presence, members } = board;
  const budgetCurrency = budget.currency || 'USD';
  const overBudget = budget.isOverBudget;
  const maxCategory = Math.max(1, ...Object.values(budget.categories || {}).map((c) => c.perPersonCents));

  return (
    <>
      <TopBar>
        <span className={`chip ${connected ? 'live' : 'danger'}`}>
          <span className={`dot ${connected ? 'pulse' : ''}`} />
          {connected ? 'live' : 'reconnecting'}
        </span>
        {driftMs !== null && <span className="chip" title="Round-trip sync latency">{driftMs}ms</span>}
      </TopBar>

      <div className="page page-wide stack" style={{ gap: 14 }}>
        <div className="room-header">
          <div className="room-title">
            <h1>{trip.destination}</h1>
            <p className="tiny muted">
              {new Date(`${trip.startDate}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
              {' – '}
              {new Date(`${trip.endDate}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
              {' · '}{members.length} traveler{members.length > 1 ? 's' : ''}
              {' · your role: '}<strong>{board.role}</strong>
            </p>
          </div>

          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(trip.inviteCode); flash('Invite code copied.'); }}>
              invite <span className="mono">{trip.inviteCode}</span>
            </button>
            {board.role === 'leader' && (
              <button className="btn btn-sm" onClick={() => lockRoom(!trip.roomLocked)}>
                {trip.roomLocked ? 'Unlock room' : 'Lock room'}
              </button>
            )}
            {canPlan && <button className="btn btn-sm btn-primary" onClick={() => setPinOpen(true)} disabled={trip.roomLocked}>+ Pin item</button>}
          </div>
        </div>

        <div className="row wrap" style={{ gap: 6 }}>
          {presence.map((person) => (
            <span key={person.userId} className={`chip ${person.role === 'leader' ? 'warn' : ''}`}>
              <span className="dot" style={{ color: 'var(--teal)' }} /> {person.name}
              {person.latencyMs ? <span className="tiny muted">{person.latencyMs}ms</span> : null}
            </span>
          ))}
          {board.leaderState?.frozen && <span className="chip danger">locks frozen — no leader online</span>}
          {trip.roomLocked && <span className="chip warn">room locked</span>}
          {conflictNotice && (
            <button className="chip danger" onClick={() => setConflictNotice(null)}>
              move conflict resolved — dismiss
            </button>
          )}
        </div>

        {conflicts.length > 0 && (
          <div className="conflict-list">
            {conflicts.map((conflict) => (
              <div key={conflict.conflictKey} className={`conflict-item ${conflict.severity === 'critical' ? 'critical' : ''}`}>
                <div className="row-between">
                  <span>⚠ {conflict.details.message}</span>
                  {conflict.conflictType === 'overlap' && canPlan && (
                    <button className="btn btn-sm btn-ghost" onClick={() => openVote(conflict.itemIds)}>Open slot vote</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="room-grid">
          <section className="stack">
            <div className="row-between">
              <h2 style={{ fontSize: 15 }}>Itinerary canvas</h2>
              <span className="tiny muted">Drag a card to another day to reschedule</span>
            </div>

            <div className="canvas">
              {days.map((dayIndex) => {
                const label = dayLabel(trip, dayIndex);
                const dayItems = itemsByDay.get(dayIndex) || [];
                const dayTotal = dayItems.reduce((sum, item) => sum + item.pricePerPersonCents, 0);
                return (
                  <div
                    key={dayIndex}
                    className={`day-col ${dragOverDay === dayIndex ? 'dragover' : ''}`}
                    onDragOver={(event) => {
                      if (!canPlan || trip.roomLocked) return;
                      event.preventDefault();
                      setDragOverDay(dayIndex);
                    }}
                    onDragLeave={() => setDragOverDay(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOverDay(null);
                      const itemId = event.dataTransfer.getData('text/plain') || draggingId;
                      const item = (board.items || []).find((i) => i.itemId === itemId);
                      if (item && item.dayIndex !== dayIndex) moveItem(item, dayIndex);
                      setDraggingId(null);
                    }}
                  >
                    <div className="day-head">
                      <div>
                        <h3>{label.title}</h3>
                        <span className="day-date">{label.date}</span>
                      </div>
                      <span className="day-total">{money(dayTotal, budgetCurrency)} pp</span>
                    </div>

                    {dayItems.length === 0 && <p className="tiny muted" style={{ padding: '8px 2px' }}>Nothing pinned yet.</p>}

                    {dayItems.map((item) => {
                      const locked = item.lifecycleStage === 'locked';
                      const voting = item.lifecycleStage === 'voting';
                      const inConflict = conflictItemIds.has(String(item.itemId));
                      return (
                        <article
                          key={item.itemId}
                          className={`item-card ${locked ? 'locked' : ''} ${voting ? 'voting' : ''} ${inConflict ? 'conflict' : ''} ${draggingId === item.itemId ? 'dragging' : ''}`}
                          draggable={canPlan && !locked && !voting && !trip.roomLocked}
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/plain', item.itemId);
                            setDraggingId(item.itemId);
                          }}
                          onDragEnd={() => setDraggingId(null)}
                        >
                          <div className="row-between">
                            <span className="item-time">{item.startTime}–{item.endTime}</span>
                            {locked && <span className="tag stage">locked</span>}
                            {voting && <span className="tag stage">voting</span>}
                          </div>
                          <div className="item-title">{item.title}</div>
                          <div className="item-meta">
                            <span className="tag cost">{money(item.pricePerPersonCents, budgetCurrency)} pp</span>
                            <span className="tag">{item.category}</span>
                            {(item.dietaryTags || []).slice(0, 2).map((tag) => <span key={tag} className="tag veg">{tag}</span>)}
                          </div>
                          {item.pinnedByName && <p className="tiny muted" style={{ marginTop: 4 }}>pinned by {item.pinnedByName}</p>}

                          <div className="item-actions">
                            {canPlan && !locked && !voting && (
                              <>
                                <button className="btn btn-sm btn-ghost" onClick={() => setMoveOpen(item)}>Time</button>
                                <button className="btn btn-sm btn-ghost" onClick={() => removeItem(item)}>Remove</button>
                              </>
                            )}
                            {(board.role === 'leader' || board.role === 'admin') && (
                              <button className="btn btn-sm btn-ghost" onClick={() => toggleLock(item)} disabled={voting}>
                                {locked ? 'Unlock' : 'Lock'}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {votes.length > 0 && (
              <div className="card stack-sm">
                <span className="card-title">Live slot votes</span>
                {votes.map((vote) => {
                  const counts = new Map();
                  for (const ballot of vote.ballots || []) {
                    counts.set(String(ballot.candidateItemId), (counts.get(String(ballot.candidateItemId)) || 0) + 1);
                  }
                  const total = Math.max(1, (vote.ballots || []).length);
                  return (
                    <div key={vote.voteId} className="vote-card stack-sm">
                      <div className="row-between tiny">
                        <span className="mono">Day {vote.slot.dayIndex + 1} · {vote.slot.startTime}</span>
                        <span className="muted">closes {new Date(vote.closesAt).toLocaleTimeString()}</span>
                      </div>
                      {vote.candidateItemIds.map((candidateId) => {
                        const item = board.items.find((i) => String(i.itemId) === String(candidateId));
                        const count = counts.get(String(candidateId)) || 0;
                        const mine = myVotes.get(String(vote.voteId)) === String(candidateId);
                        return (
                          <div key={candidateId} className="stack-sm" style={{ gap: 2 }}>
                            <div className="row-between tiny">
                              <span>{item ? item.title : 'Candidate'} {mine && <span className="tag veg">your vote</span>}</span>
                              <span className="muted">{count}/{total}</span>
                            </div>
                            <div className="vote-bar"><span style={{ width: `${(count / total) * 100}%` }} /></div>
                            <div className="row" style={{ gap: 6 }}>
                              <button className="btn btn-sm btn-ghost" disabled={!canPlan} onClick={() => castVote(vote.voteId, candidateId)}>Vote</button>
                              {board.role === 'leader' && (
                                <button className="btn btn-sm btn-ghost" onClick={() => resolveVote(vote.voteId)}>Resolve now</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {board.role === 'leader' && (
              <div className="card stack-sm">
                <span className="card-title">Leader controls</span>
                <div className="row wrap" style={{ gap: 8 }}>
                  <select className="input" style={{ maxWidth: 220 }}
                    onChange={(e) => transferLeader(e.target.value)} defaultValue="">
                    <option value="" disabled>Transfer leader to…</option>
                    {members.filter((m) => String(m.userId) !== String(user.userId)).map((m) => (
                      <option key={m.userId} value={m.userId}>{m.name}</option>
                    ))}
                  </select>
                  <button className="btn btn-sm" onClick={completeTrip}>Complete trip</button>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {members.map((m) => (
                    <span key={m.userId} className="chip">
                      {m.name} · {m.role}{m.muted ? ' · muted' : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="side-panel">
            <div className="panel-tabs">
              {['budget', 'chat', 'concierge'].map((name) => (
                <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
                  {name === 'budget' ? 'Budget' : name === 'chat' ? 'Chat' : 'AI Concierge'}
                </button>
              ))}
            </div>

            {tab === 'budget' && (
              <div className="card stack-sm">
                <div className="row-between">
                  <span className="card-title">Live budget</span>
                  <span className={`chip ${overBudget ? 'danger' : 'live'}`}>{overBudget ? 'over budget' : `${budget.utilizationPct}% used`}</span>
                </div>
                <div className="budget-big">{money(budget.groupTotalCents, budgetCurrency)}</div>
                <p className="tiny muted">
                  of {money(budget.totalBudgetCents, budgetCurrency)} · {money(budget.perPersonSubtotalCents, budgetCurrency)} per person
                  {' · '}{budget.mode} split
                </p>
                <div className={`meter ${overBudget ? 'over' : ''}`}>
                  <span style={{ width: `${Math.min(100, budget.utilizationPct)}%` }} />
                </div>
                <p className="tiny" style={{ color: overBudget ? 'var(--danger)' : 'var(--teal)' }}>
                  {overBudget
                    ? `${money(Math.abs(budget.remainingCents), budgetCurrency)} over the ceiling`
                    : `${money(budget.remainingCents, budgetCurrency)} remaining`}
                </p>

                <div className="stack-sm" style={{ marginTop: 6 }}>
                  {Object.entries(budget.categories || {}).map(([category, data]) => (
                    <div key={category} className="cat-row">
                      <span className="muted">{category}</span>
                      <div className="cat-bar"><span style={{ width: `${(data.perPersonCents / maxCategory) * 100}%` }} /></div>
                      <span className="tiny muted" style={{ textAlign: 'right' }}>{money(data.perPersonCents, budgetCurrency)}</span>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 8 }}>
                  <span className="card-title">Per traveler</span>
                  {budget.members.map((member) => (
                    <div key={member.userId} className={`person-row ${member.overCeiling ? 'over' : ''}`}>
                      <span>{member.name}{member.overCeiling ? ' ⚠' : ''}</span>
                      <span>{money(member.shareCents, budgetCurrency)}</span>
                    </div>
                  ))}
                  <div className="person-row" style={{ fontWeight: 700 }}>
                    <span>Reconciles to</span>
                    <span>{money(budget.sharesSumCents, budgetCurrency)}</span>
                  </div>
                </div>
              </div>
            )}

            {tab === 'chat' && (
              <div className="card stack-sm">
                <div className="row-between">
                  <span className="card-title">Group chat</span>
                  <span className="tiny muted">{messages.length} messages</span>
                </div>
                <div className="chat-feed">
                  {messages.map((message) => {
                    const mine = message.reactions?.some((r) => (r.userIds || []).map(String).includes(String(user.userId)));
                    return (
                      <div key={message.messageId} className={`msg ${message.msgType === 'ai_answer' ? 'ai' : ''} ${message.msgType === 'system' ? 'system' : ''}`}>
                        <div className="msg-head">
                          <span className="msg-author" style={{ color: message.msgType === 'ai_answer' ? 'var(--teal)' : undefined }}>
                            {message.authorName}
                          </span>
                          <span className="msg-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div className="msg-body">{message.body}</div>
                        <div className="reactions">
                          {(message.reactions || []).map((reaction) => (
                            <button
                              key={reaction.emoji}
                              className={`reaction ${mine ? 'mine' : ''}`}
                              onClick={() => socketRef.current?.emit('trip.chat.react', { tripId, payload: { messageId: message.messageId, emoji: reaction.emoji } })}
                            >
                              {reaction.emoji} {reaction.userIds.length}
                            </button>
                          ))}
                          {['👍', '❤️', '🔥'].map((emoji) => (
                            <button
                              key={emoji}
                              className="reaction"
                              title={`React ${emoji}`}
                              onClick={() => socketRef.current?.emit('trip.chat.react', { tripId, payload: { messageId: message.messageId, emoji } })}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <div className="typing">
                  {typingUsers.length > 0 && `${typingUsers.map((u) => u.name).join(', ')} typing…`}
                </div>
                <form className="row" onSubmit={sendChat} style={{ gap: 6 }}>
                  <input className="input" placeholder="Message the group…" value={chatDraft}
                    onChange={(e) => onChatTyping(e.target.value)} maxLength={2000} />
                  <button className="btn btn-primary btn-sm" type="submit">Send</button>
                </form>
              </div>
            )}

            {tab === 'concierge' && (
              <div className="card stack-sm">
                <div className="row-between">
                  <span className="card-title">AI Concierge</span>
                  <span className="chip">grounded</span>
                </div>

                <form className="stack-sm" onSubmit={askConcierge}>
                  <textarea className="input" rows={2} placeholder="e.g. Suggest a vegan dinner near our 5 PM sunset under $25 per person"
                    value={aiQuestion} onChange={(e) => setAiQuestion(e.target.value)} maxLength={500} />
                  <div className="row" style={{ gap: 6 }}>
                    <select className="input" value={aiAnchor} onChange={(e) => setAiAnchor(e.target.value)}>
                      <option value="">No anchor event</option>
                      {(board.items || []).map((item) => (
                        <option key={item.itemId} value={item.itemId}>
                          {item.startTime} · {item.title}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-primary btn-sm" type="submit" disabled={aiBusy || !canPlan}>
                      {aiBusy ? '…' : 'Ask'}
                    </button>
                  </div>
                </form>

                {!canPlan && <p className="tiny muted">Viewers can read the concierge transcript but cannot ask.</p>}

                {(aiLatest || messages.some((m) => m.msgType === 'ai_answer')) && !aiLatest && (
                  <div className="ai-answer">
                    <h4>Latest answer</h4>
                    <p>{[...messages].reverse().find((m) => m.msgType === 'ai_answer')?.body}</p>
                  </div>
                )}

                {aiLatest && (
                  <div className="ai-answer stack-sm">
                    <div className="row-between">
                      <h4>Answer</h4>
                      <span className="tiny muted">{aiLatest.engine} · {aiLatest.latencyMs}ms</span>
                    </div>
                    <p>{aiLatest.answer}</p>

                    <div className="constraint-grid">
                      <span>ceiling <strong>{money(aiLatest.constraints.maxPriceCents, budgetCurrency)}</strong></span>
                      <span>diet <strong>{(aiLatest.constraints.dietaryTags || []).join(', ') || 'none'}</strong></span>
                      <span>radius <strong>{aiLatest.constraints.radiusKm} km</strong></span>
                      <span>slot <strong>{aiLatest.constraints.slot ? `${aiLatest.constraints.slot.startTime}–${aiLatest.constraints.slot.endTime}` : 'any'}</strong></span>
                      <span>candidates <strong>{aiLatest.candidateStats.valid}</strong></span>
                      <span>rejected <strong>{aiLatest.candidateStats.rejected}</strong></span>
                    </div>

                    <div className="ai-sources">
                      {aiLatest.sources.map((source) => (
                        <div key={source.venueId} className="ai-source">
                          <div className="row-between">
                            <strong>{source.name}</strong>
                            <span className="tiny mono muted">{source.venueId}</span>
                          </div>
                          <div className="tiny muted">
                            {money(source.pricePerPersonCents, budgetCurrency)} pp · {source.rating}★
                            {source.distanceKm !== null ? ` · ${source.distanceKm} km` : ''}
                            {source.hours ? ` · open ${source.hours.open}-${source.hours.close}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>

                    {aiLatest.rejected.length > 0 && (
                      <details>
                        <summary className="tiny muted" style={{ cursor: 'pointer' }}>Why other venues were excluded</summary>
                        <div className="stack-sm" style={{ marginTop: 6 }}>
                          {aiLatest.rejected.map((rejection) => (
                            <p key={rejection.venueId} className="tiny muted">
                              {rejection.name}: {rejection.reasons.join(', ')}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>

      {pinOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPinOpen(false)}>
          <div className="card modal">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h3>Pin a venue</h3>
              <button className="btn btn-sm btn-ghost" onClick={() => setPinOpen(false)}>Close</button>
            </div>
            <form className="stack" onSubmit={pinItem}>
              <div className="row" style={{ gap: 10 }}>
                <div className="field grow">
                  <label>Day</label>
                  <select className="input" value={pinForm.dayIndex} onChange={(e) => setPinForm({ ...pinForm, dayIndex: e.target.value })}>
                    {days.map((dayIndex) => (
                      <option key={dayIndex} value={dayIndex}>{dayLabel(trip, dayIndex).title} · {dayLabel(trip, dayIndex).date}</option>
                    ))}
                  </select>
                </div>
                <div className="field grow">
                  <label>Start</label>
                  <select className="input" value={pinForm.startTime} onChange={(e) => setPinForm({ ...pinForm, startTime: e.target.value })}>
                    {TIME_SLOTS.map((time) => <option key={time} value={time}>{time}</option>)}
                  </select>
                </div>
                <div className="field grow">
                  <label>Duration</label>
                  <select className="input" value={pinForm.durationMinutes} onChange={(e) => setPinForm({ ...pinForm, durationMinutes: e.target.value })}>
                    {[60, 90, 120, 180].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Venue catalog — {catalog.length} options</label>
                <input className="input" placeholder="Filter venues…" onChange={(e) => {
                  const value = e.target.value.toLowerCase();
                  document.querySelectorAll('[data-venue-row]').forEach((row) => {
                    row.style.display = row.dataset.venueRow.toLowerCase().includes(value) ? '' : 'none';
                  });
                }} />
                <div className="stack-sm" style={{ maxHeight: 300, overflowY: 'auto', marginTop: 4 }}>
                  {catalog.map((venue) => (
                    <label
                      key={venue.venueId}
                      className={`venue-row ${pinForm.venueId === venue.venueId ? 'selected' : ''}`}
                      data-venue-row={`${venue.name} ${venue.category} ${(venue.dietaryTags || []).join(' ')}`}
                    >
                      <input
                        type="radio"
                        name="venue"
                        checked={pinForm.venueId === venue.venueId}
                        onChange={() => setPinForm({ ...pinForm, venueId: venue.venueId })}
                        style={{ marginTop: 3 }}
                      />
                      <span className="grow">
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{venue.name}</span>
                        <span className="tiny muted" style={{ display: 'block' }}>
                          {venue.category} · open {venue.hours.open}-{venue.hours.close} · {venue.rating}★
                          {(venue.dietaryTags || []).length ? ` · ${venue.dietaryTags.join(', ')}` : ''}
                        </span>
                      </span>
                      <span className="tiny nowrap" style={{ color: 'var(--teal)' }}>{money(venue.pricePerPersonCents, budgetCurrency)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button className="btn btn-primary" type="submit" disabled={!pinForm.venueId}>Pin to day {Number(pinForm.dayIndex) + 1}</button>
            </form>
          </div>
        </div>
      )}

      {moveOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setMoveOpen(null)}>
          <div className="card modal" style={{ maxWidth: 420 }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <h3>Reschedule “{moveOpen.title}”</h3>
              <button className="btn btn-sm btn-ghost" onClick={() => setMoveOpen(null)}>Close</button>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>Day</label>
                <select className="input" id="move-day" defaultValue={moveOpen.dayIndex}>
                  {days.map((dayIndex) => (
                    <option key={dayIndex} value={dayIndex}>{dayLabel(trip, dayIndex).title} · {dayLabel(trip, dayIndex).date}</option>
                  ))}
                </select>
              </div>
              <div className="field grow">
                <label>Start</label>
                <select className="input" id="move-time" defaultValue={moveOpen.startTime}>
                  {TIME_SLOTS.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </div>
            </div>
            <button
              className="btn btn-primary"
              style={{ marginTop: 14 }}
              onClick={() => {
                const dayIndex = Number(document.getElementById('move-day').value);
                const startTime = document.getElementById('move-time').value;
                moveItemToSlot(moveOpen, dayIndex, startTime);
              }}
            >
              Save new slot
            </button>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </>
  );
}
