// Outbound email via the Brevo HTTP API (api.brevo.com) instead of SMTP.
//
// Why this exists: the Render service cannot open an SMTP session to
// Brevo at all — measured live 2026-11-14, both port 587 (STARTTLS)
// and port 465 (implicit TLS) fail with "Connection timeout" after
// the 10s transport timeout, even with the Active OrbitApp SMTP key
// on Render. Brevo's relay is reachable from the internet (TCP
// connects fine), so the fault is the Render -> Brevo SMTP path, not
// the key, the sender, or the relay. HTTPS to api.brevo.com rides
// port 443 like every other outbound call the app already makes
// (Metered, Google), so it bypasses the blocked SMTP path entirely.
//
// Channel choice (see pickEmailChannel): the Brevo API is used
// whenever BREVO_API_KEY is set; otherwise the existing nodemailer
// SMTP transport is used; when neither is configured, mail is not
// sent and the caller fails closed (account stays unverified).
//
// The API key is a Brevo *API* key, not the SMTP key: Brevo ->
// SMTP & API -> API Keys -> Generate. It goes straight into Render
// as BREVO_API_KEY — never through chat, screenshots, or the repo.
// The sender address (SMTP_FROM, else SMTP_USER) must still be a
// Brevo-verified sender; the API rejects an unverified sender fast
// with a 400, which surfaces in the log instead of a timeout.
const logger = require('./logger');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_API_TIMEOUT_MS = 10_000; // same fail-fast budget as SMTP

const isBrevoApiConfigured = () => Boolean(process.env.BREVO_API_KEY);

// Pure channel decision, so tests can assert it without a network:
// 'brevo-api' wins when its key is set, else 'smtp' when SMTP is
// configured, else 'none' (mail disabled, caller fails closed).
const pickEmailChannel = ({ smtpConfigured }) => {
  if (isBrevoApiConfigured()) return 'brevo-api';
  if (smtpConfigured) return 'smtp';
  return 'none';
};

// Send one message through the Brevo HTTP API. Returns
// { sent: true } or { sent: false, reason } and never throws, so a
// dead API key, an unverified sender, or a hung request degrades to
// "mail not sent" instead of taking down registration/resend.
// `fetchImpl` is injectable so tests can stub the network; `timeoutMs`
// is overridable so tests need not wait the full 10s.
const sendViaBrevoApi = async (
  { to, subject, text, html },
  { fetchImpl, timeoutMs } = {}
) => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, reason: 'brevo-api-not-configured' };
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { sent: false, reason: 'brevo-api-no-fetch' };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  // The API wants a bare address; SMTP_FROM may carry a display name
  // ("Orbit <orbit@example.com>"), which nodemailer accepts but the
  // API rejects — strip it when present.
  const senderEmail = (from.match(/<([^>]+)>/) || [])[1] || from.trim();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs === undefined ? BREVO_API_TIMEOUT_MS : timeoutMs
  );
  try {
    const res = await fetchFn(BREVO_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { email: senderEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = (data && (data.message || data.code)) || '';
      } catch {
        detail = '';
      }
      logger.warn(
        { status: res.status, detail },
        'Brevo API rejected the email'
      );
      return { sent: false, reason: 'brevo-api-rejected' };
    }
    return { sent: true };
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      'Brevo API email send failed'
    );
    return { sent: false, reason: 'brevo-api-failed' };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  BREVO_API_URL,
  BREVO_API_TIMEOUT_MS,
  isBrevoApiConfigured,
  pickEmailChannel,
  sendViaBrevoApi
};
