'use strict';

/**
 * HTTP client for the Bridge admin API.
 *
 * Uses Node's built-in fetch (>= 18). All methods throw an ApiError
 * (with .status and .exitCode) on non-2xx responses so callers can
 * short-circuit with process.exit(err.exitCode).
 */

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    if (status === 401 || status === 403) this.exitCode = 2;
    else if (status === 404) this.exitCode = 3;
    else this.exitCode = 1;
  }
}

const buildBaseUrl = (session) => {
  const port = session.port || 3000;
  const host = String(session.host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const scheme = session.scheme || 'http';
  return `${scheme}://${host}:${port}`;
};

const request = async (session, method, pathname, body) => {
  const baseUrl = buildBaseUrl(session);
  const url = `${baseUrl}${pathname}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `Network error: ${msg} (url=${url})`);
  }

  let parsed = null;
  const raw = await response.text();
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch { parsed = { error: raw }; }
  }

  if (!response.ok) {
    const message = (parsed && parsed.error) || response.statusText || `HTTP ${response.status}`;
    throw new ApiError(response.status, message, parsed);
  }

  return parsed || {};
};

// ── Public API surface ──────────────────────────────────────────────────

const login = async ({ host, port, password, scheme }) => {
  const session = { host, port, scheme };
  const result = await request(session, 'POST', '/admin/login', { password });
  return {
    ...session,
    token: result.token,
    expires_at: result.expires_at,
  };
};

const logout = (session) => request(session, 'POST', '/admin/logout');

const info = (session) => request(session, 'GET', '/admin/info');

const listRoutes = async (session) => {
  const result = await request(session, 'GET', '/admin/routes');
  return result.routes || [];
};

const getRoute = async (session, routeId) => {
  const result = await request(session, 'GET', `/admin/routes/${encodeURIComponent(routeId)}`);
  return result.route;
};

const createRoute = async (session, route) => {
  const result = await request(session, 'POST', '/admin/routes', route);
  return result.route;
};

const updateRoute = async (session, routeId, patch) => {
  const result = await request(session, 'PUT', `/admin/routes/${encodeURIComponent(routeId)}`, patch);
  return result.route;
};

const deleteRoute = (session, routeId) =>
  request(session, 'DELETE', `/admin/routes/${encodeURIComponent(routeId)}`);

const enableRoute = (session, routeId) =>
  request(session, 'POST', `/admin/routes/${encodeURIComponent(routeId)}/enable`);

const disableRoute = (session, routeId) =>
  request(session, 'POST', `/admin/routes/${encodeURIComponent(routeId)}/disable`);

module.exports = {
  ApiError,
  login,
  logout,
  info,
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  enableRoute,
  disableRoute,
};
