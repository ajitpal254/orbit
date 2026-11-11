// Central API helper: cookie sessions + double-submit CSRF, same pattern
// as the Calorie-Tracker frontend.
//
// Cold-load race, fixed here: the app bootstraps the csrfToken cookie on
// mount, but a fast submit (or an automated login) could fire before that
// fetch landed, sending an empty x-csrf-token header and getting a 403
// without the password ever being checked. So every non-GET call first
// makes sure a token exists, and a 403 "Invalid CSRF token" refreshes the
// token and retries the request once. The retry also covers expired or
// replaced cookies later in the session.

export const getCookie = (name) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return '';
};

// Fetch a fresh csrfToken cookie (the response's Set-Cookie stores it;
// the token itself is read back from document.cookie by apiFetch).
const refreshCsrfToken = () =>
  fetch('/api/auth/csrf-token', { credentials: 'include' }).catch(() => {});

const ensureCsrfToken = async () => {
  if (!getCookie('csrfToken')) await refreshCsrfToken();
};

export const apiFetch = (url, options = {}) => {
  const { headers = {}, ...rest } = options;
  return fetch(url, {
    credentials: 'include',
    ...rest,
    headers: {
      ...headers,
      // Always the fresh cookie value: a caller-supplied header may be a
      // stale copy captured before the bootstrap fetch landed.
      'x-csrf-token': getCookie('csrfToken')
    }
  });
};

export const apiJson = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') await ensureCsrfToken();
  let res = await apiFetch(url, options);
  if (res.status === 403 && method !== 'GET') {
    const probe = await res.clone().json().catch(() => ({}));
    if (probe.error === 'Invalid CSRF token') {
      await refreshCsrfToken();
      res = await apiFetch(url, options);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};

const jsonPost = (url, body) =>
  apiJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });

// --- Friends ---

export const searchUsers = (q) =>
  apiJson(`/api/users/search?q=${encodeURIComponent(q)}`);

export const getFriends = () => apiJson('/api/friends');

export const sendFriendRequest = (userId) => jsonPost('/api/friends/request', { userId });

export const acceptFriendRequest = (userId) => jsonPost('/api/friends/accept', { userId });

export const declineFriendRequest = (userId) => jsonPost('/api/friends/decline', { userId });

export const removeFriend = (userId) =>
  apiJson(`/api/friends/${userId}`, { method: 'DELETE' });

// --- Room invites ---

export const getInvites = () => apiJson('/api/invites');

export const acceptInvite = (inviteId) => jsonPost(`/api/invites/${inviteId}/accept`);

export const declineInvite = (inviteId) => jsonPost(`/api/invites/${inviteId}/decline`);

export const inviteToRoom = (roomId, userId) => jsonPost(`/api/rooms/${roomId}/invite`, { userId });

export const leavePrivateRoom = (roomId) => jsonPost(`/api/rooms/${roomId}/leave`);

// --- Direct messages ---

export const getDms = () => apiJson('/api/dms');

export const getDmThread = (userId) => apiJson(`/api/dms/${userId}`);

export const sendDm = (userId, text) =>
  jsonPost(`/api/dms/${userId}`, { text });
