import { io } from 'socket.io-client';
import { tokenStore } from './api';

/**
 * One socket per browser tab. The token is read at connect time so a refreshed
 * access token automatically applies on the next reconnect.
 */
export function createTripSocket() {
  return io({
    autoConnect: false,
    auth: { token: tokenStore.get() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
}

export function emitAsync(socket, event, payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      if (ack && ack.ok === false) {
        const error = new Error(ack.message || ack.code || 'Rejected');
        error.code = ack.code;
        reject(error);
        return;
      }
      resolve(ack);
    });
  });
}
