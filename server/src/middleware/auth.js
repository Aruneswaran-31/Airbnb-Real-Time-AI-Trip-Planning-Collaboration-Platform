'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Trip = require('../models/Trip');
const { ApiError } = require('./errors');

const ROLE_RANK = { viewer: 1, planner: 2, leader: 3, admin: 4 };

function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.globalRole, email: user.email, tv: user.tokenVersion || 0 },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl, issuer: config.jwt.issuer, audience: 'access' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { sub: String(user._id), tv: user.tokenVersion || 0 },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshTtl, issuer: config.jwt.issuer, audience: 'refresh' }
  );
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwt.accessSecret, {
      issuer: config.jwt.issuer,
      audience: 'access',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new ApiError(401, 'token_expired', 'Access token expired');
    throw ApiError.unauthorized('invalid_token', 'Invalid access token');
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, config.jwt.refreshSecret, {
      issuer: config.jwt.issuer,
      audience: 'refresh',
    });
  } catch {
    throw ApiError.unauthorized('invalid_refresh_token', 'Invalid or expired refresh token');
  }
}

function bearerFrom(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Authenticate a request and attach `req.user` (without passwordHash). */
async function requireAuth(req, _res, next) {
  try {
    const token = bearerFrom(req);
    if (!token) throw ApiError.unauthorized();
    const claims = verifyAccessToken(token);
    const user = await User.findById(claims.sub);
    if (!user) throw ApiError.unauthorized('unknown_user', 'User no longer exists');
    if ((user.tokenVersion || 0) !== claims.tv) {
      throw ApiError.unauthorized('token_revoked', 'Session was revoked, please sign in again');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Optional auth: attaches req.user when a valid token is present, never rejects. */
async function optionalAuth(req, _res, next) {
  const token = bearerFrom(req);
  if (!token) return next();
  try {
    const claims = verifyAccessToken(token);
    const user = await User.findById(claims.sub);
    if (user && (user.tokenVersion || 0) === claims.tv) req.user = user;
  } catch {
    /* anonymous */
  }
  return next();
}

async function resolveTripRole(user, trip) {
  if (user.globalRole === 'admin') return 'admin';
  return trip.roleFor(user);
}

/** Loads req.trip + req.tripRole for routes with :id trip parameter. */
async function loadTrip(req, _res, next) {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) throw ApiError.notFound('trip_not_found', 'Trip room not found');
    req.trip = trip;
    req.tripRole = await resolveTripRole(req.user, trip);
    if (!req.tripRole) {
      throw ApiError.forbidden('not_a_member', 'You are not a participant in this trip room');
    }
    next();
  } catch (err) {
    next(err);
  }
}

function rank(role) {
  return ROLE_RANK[role] || 0;
}

/** Role gate: viewer < planner < leader < admin. */
function requireTripRole(minRole) {
  return (req, _res, next) => {
    const role = req.tripRole;
    if (!role) return next(ApiError.forbidden('not_a_member', 'You are not a participant in this trip room'));
    if (rank(role) < rank(minRole)) {
      return next(
        ApiError.forbidden(
          'insufficient_role',
          `This action requires the ${minRole} role; your role is ${role}`
        )
      );
    }
    return next();
  };
}

function requireGlobalRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (rank(req.user.globalRole) < rank(role)) {
      return next(
        ApiError.forbidden('insufficient_role', `This action requires the ${role} role; your role is ${req.user.globalRole}`)
      );
    }
    return next();
  };
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  requireAuth,
  optionalAuth,
  loadTrip,
  requireTripRole,
  requireGlobalRole,
  resolveTripRole,
  ROLE_RANK,
  rank,
};
