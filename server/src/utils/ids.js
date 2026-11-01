'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Invite code in the PRD format: AB-7Q2K (2 letters, dash, 4 alphanumerics).
 * Uses an unambiguous alphabet (no O/0, I/1) so codes survive being read aloud.
 */
function generateInviteCode() {
  const bytes = crypto.randomBytes(6);
  const pick = (i) => ALPHABET[bytes[i] % ALPHABET.length];
  return `${pick(0)}${pick(1)}-${pick(2)}${pick(3)}${pick(4)}${pick(5)}`;
}

/** URL-safe random id with a readable prefix, e.g. tr_9f2kba1c. */
function shortId(prefix) {
  const id = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${id}`;
}

/** Deterministic correlation id for a room session / request trace. */
function correlationId(prefix = 'cid') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = { generateInviteCode, shortId, correlationId, ALPHABET };
