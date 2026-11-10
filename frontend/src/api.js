// Central API helper: cookie sessions + double-submit CSRF, same pattern
// as the Calorie-Tracker frontend.

export const getCookie = (name) => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return '';
};

export const apiFetch = (url, options = {}) => {
  const { headers = {}, ...rest } = options;
  return fetch(url, {
    credentials: 'include',
    ...rest,
    headers: {
      'x-csrf-token': getCookie('csrfToken'),
      ...headers
    }
  });
};

export const apiJson = async (url, options = {}) => {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};
