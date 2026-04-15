import {
  APP_STORAGE_ID,
  SPOTIFY_SCOPES,
  SPOTIFY_AUTH_URL,
  SPOTIFY_TOKEN_URL,
  PKCE_VERIFIER_LENGTH,
} from './config.js';

const SS_VERIFIER = `${APP_STORAGE_ID}:pkce_verifier`;
const SS_STATE = `${APP_STORAGE_ID}:oauth_state`;
const SS_CLIENT = `${APP_STORAGE_ID}:oauth_client_id`;
const SS_REDIRECT = `${APP_STORAGE_ID}:oauth_redirect`;
function base64UrlEncode(bytes) {
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  const arr = new Uint8Array(PKCE_VERIFIER_LENGTH);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function sha256Base64Url(input) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return base64UrlEncode(digest);
}

export function getRedirectUri() {
  const u = new URL(window.location.href);
  u.hash = '';
  let path = u.pathname;
  if (path.endsWith('/index.html')) {
    path = path.slice(0, -'index.html'.length);
  }
  if (!path.endsWith('/')) {
    path += '/';
  }
  u.pathname = path;
  u.search = '';
  return u.href;
}

/**
 * @param {string} clientId
 */
export async function beginLogin(clientId) {
  const redirectUri = getRedirectUri();
  const verifier = randomVerifier();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  sessionStorage.setItem(SS_VERIFIER, verifier);
  sessionStorage.setItem(SS_STATE, state);
  sessionStorage.setItem(SS_CLIENT, clientId);
  sessionStorage.setItem(SS_REDIRECT, redirectUri);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    scope: SPOTIFY_SCOPES,
    state,
  });

  const challenge = await sha256Base64Url(verifier);
  params.set('code_challenge', challenge);
  window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * @returns {Promise<{ tokens: object, clientId: string } | { error: string } | null>}
 */
export async function consumeOAuthCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  if (err) {
    cleanUrl();
    return { error: err };
  }
  if (!code || !state) return null;

  const expected = sessionStorage.getItem(SS_STATE);
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  const clientId = sessionStorage.getItem(SS_CLIENT);
  const redirectUri = sessionStorage.getItem(SS_REDIRECT);

  if (!expected || state !== expected || !verifier || !clientId || !redirectUri) {
    sessionStorage.removeItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_STATE);
    sessionStorage.removeItem(SS_CLIENT);
    sessionStorage.removeItem(SS_REDIRECT);
    cleanUrl();
    return { error: 'oauth_state_mismatch' };
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  sessionStorage.removeItem(SS_VERIFIER);
  sessionStorage.removeItem(SS_STATE);
  sessionStorage.removeItem(SS_CLIENT);
  sessionStorage.removeItem(SS_REDIRECT);

  cleanUrl();

  if (!res.ok) {
    const text = await res.text();
    return { error: `token_exchange_failed:${text}` };
  }

  const json = await res.json();
  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };

  /** Samma client_id som vid authorize — formuläret är tomt efter omdirigering. */
  return { tokens, clientId };
}

function cleanUrl() {
  const u = new URL(window.location.href);
  u.search = '';
  window.history.replaceState({}, '', u.pathname + u.hash);
}

/**
 * @param {string} refreshToken
 * @param {string} clientId
 */
export async function refreshAccessToken(refreshToken, clientId) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`refresh_failed:${t}`);
  }
  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}
