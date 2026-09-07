/** PokeBin PKCE auth helper for the Showdown client */
const POKEBIN_BASE = (() => {
  // POKEBIN_HOST is injected into Config by `POKEBIN_HOST=... npm run build`.
  // Local development keeps using the local PokeBin server automatically.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:2000';
  }
  // Production deployment target. This explicit mapping avoids relying on a
  // separately cached Config asset for the OAuth/API host.
  if (location.hostname === 'showdown.malaow3.com') {
    return 'https://pokebin.malaow3.com';
  }
  const host = (globalThis as any).Config?.pokebinHost || 'pokebin.malaow3.com';
  return host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`;
})();

const TOKEN_KEY = 'pokebin_access_token';
const EXPIRY_KEY = 'pokebin_token_expiry';

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function getPokebinBase(): string {
  return POKEBIN_BASE;
}

// Refresh a little early, but keep the synchronous getter valid until actual expiry.
const REFRESH_TOKEN_KEY = 'pokebin_refresh_token';
const REFRESH_EXPIRY_KEY = 'pokebin_refresh_expiry';
const REFRESH_SKEW_MS = 60 * 1000;
let authGeneration = 0;
let refreshRequest: Promise<string | null> | null = null;

interface PokebinTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
}

export function getPokebinAccessToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(EXPIRY_KEY);
  if (expiry && Date.now() >= Number(expiry)) return null;
  return token;
}

function getPokebinRefreshToken(): string | null {
  const expiry = localStorage.getItem(REFRESH_EXPIRY_KEY);
  if (expiry && Date.now() >= Number(expiry)) return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function isPokebinLoggedIn(): boolean {
  return !!(getPokebinAccessToken() || getPokebinRefreshToken());
}

function forgetPokebinAuth(): void {
  authGeneration++;
  refreshRequest = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(REFRESH_EXPIRY_KEY);
  sessionStorage.removeItem('pokebin_verifier');
  sessionStorage.removeItem('pokebin_state');
}

function revokePokebinToken(refreshToken: string): void {
  // Disconnect is local even if the server is offline or does not support revoke.
  void fetch(`${POKEBIN_BASE}/api/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'showdown-web', refresh_token: refreshToken }),
  }).catch(() => {});
}

export function clearPokebinAuth(): void {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  forgetPokebinAuth();
  if (refreshToken) revokePokebinToken(refreshToken);
}

function setPokebinToken(json: PokebinTokenResponse): void {
  localStorage.setItem(TOKEN_KEY, json.access_token!);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + json.expires_in! * 1000));
  if (json.refresh_token) {
    localStorage.setItem(REFRESH_TOKEN_KEY, json.refresh_token);
    if (json.refresh_expires_in) {
      localStorage.setItem(REFRESH_EXPIRY_KEY, String(Date.now() + json.refresh_expires_in * 1000));
    } else {
      localStorage.removeItem(REFRESH_EXPIRY_KEY);
    }
  } else {
    // Older servers only issue an access token.
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(REFRESH_EXPIRY_KEY);
  }
}

function renewPokebinAccessToken(rejectedToken?: string): Promise<string | null> {
  if (refreshRequest) return refreshRequest;
  const generation = authGeneration;
  const renew = async (): Promise<string | null> => {
    if (generation !== authGeneration) return null;
    // Read inside the cross-tab lock: another tab may already have rotated.
    const accessToken = getPokebinAccessToken();
    const expiry = Number(localStorage.getItem(EXPIRY_KEY));
    const refreshToken = getPokebinRefreshToken();
    if (accessToken && (rejectedToken ? accessToken !== rejectedToken :
      !refreshToken || !expiry || expiry > Date.now() + REFRESH_SKEW_MS)) {
      return accessToken;
    }
    if (!refreshToken) {
      if (rejectedToken && localStorage.getItem(TOKEN_KEY) === rejectedToken) forgetPokebinAuth();
      return null;
    }
    const res = await fetch(`${POKEBIN_BASE}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'showdown-web', grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    });
    const json = await res.json() as PokebinTokenResponse & { error?: string };
    if (generation !== authGeneration || localStorage.getItem(REFRESH_TOKEN_KEY) !== refreshToken) {
      // A disconnect (including one in another tab) must win over this response.
      if (res.ok && json.refresh_token && !localStorage.getItem(REFRESH_TOKEN_KEY)) {
        revokePokebinToken(json.refresh_token);
      }
      return generation === authGeneration && getPokebinRefreshToken() ? getPokebinAccessToken() : null;
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500 && json.error === 'invalid_grant') {
        forgetPokebinAuth();
        return null;
      }
      // Network, server, and unrecognized errors must not destroy the session.
      throw new Error(`PokeBin token refresh failed: ${res.status}`);
    }
    if (!json.access_token || !json.expires_in) {
      throw new Error('PokeBin token refresh returned an invalid response');
    }
    setPokebinToken(json);
    return json.access_token;
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const request = locks ? locks.request('pokebin-refresh', renew) : renew();
  refreshRequest = request;
  void request.then(() => {
    if (refreshRequest === request) refreshRequest = null;
  }, () => {
    if (refreshRequest === request) refreshRequest = null;
  });
  return request;
}

export async function connectPokebin(): Promise<string | null> {
  const generation = authGeneration;
  const verifier = randomString(32);
  const challenge = await pkceChallenge(verifier);
  if (generation !== authGeneration) return null;
  const state = randomString(16);

  sessionStorage.setItem('pokebin_verifier', verifier);
  sessionStorage.setItem('pokebin_state', state);

  const redirectUri = `${location.origin}/pokebin-callback`;
  const params = new URLSearchParams({
    client_id: 'showdown-web',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const url = `${POKEBIN_BASE}/auth/client/start?${params.toString()}`;
  const popup = window.open(url, 'pokebin-auth', 'width=520,height=640');

  if (!popup) {
    // fallback: navigate current tab
    location.href = url;
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        window.removeEventListener('message', handler);
        resolve(null);
      }
    }, 10 * 60 * 1000);

    const handler = async (event: MessageEvent) => {
      // only accept messages from the expected callback origin
      if (event.origin !== location.origin) return;
      const data = event.data as any;
      if (!data || data.type !== 'pokebin-auth-callback') return;
      if (done) return;
      const expectedState = sessionStorage.getItem('pokebin_state');
      if (data.state !== expectedState) {
        console.error('PokeBin auth state mismatch');
        return;
      }
      done = true;
      clearTimeout(timeout);
      window.removeEventListener('message', handler);

      const code: string = data.code;
      const storedVerifier = sessionStorage.getItem('pokebin_verifier')!;
      sessionStorage.removeItem('pokebin_verifier');
      sessionStorage.removeItem('pokebin_state');

      try {
        const res = await fetch(`${POKEBIN_BASE}/api/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: 'showdown-web',
            code,
            redirect_uri: redirectUri,
            code_verifier: storedVerifier,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          console.error('PokeBin token exchange failed', res.status, txt);
          resolve(null);
          return;
        }
        const json = await res.json() as PokebinTokenResponse;
        if (!json.access_token || !json.expires_in) {
          console.error('PokeBin token response did not contain an access token', json);
          resolve(null);
          return;
        }
        if (generation !== authGeneration) {
          if (json.refresh_token) revokePokebinToken(json.refresh_token);
          resolve(null);
          return;
        }
        setPokebinToken(json);
        resolve(json.access_token);
      } catch (e) {
        console.error(e);
        resolve(null);
      }
    };

    window.addEventListener('message', handler);

    // poll for popup closed
    const poll = setInterval(() => {
      if (popup.closed && !done) {
        done = true;
        clearTimeout(timeout);
        clearInterval(poll);
        window.removeEventListener('message', handler);
        resolve(null);
      }
      if (done) clearInterval(poll);
    }, 500);
  });
}

export async function uploadPokebinAuthenticated(encodedData: string, visibility: 'private' | 'public' = 'private'): Promise<string | null> {
  let token = await renewPokebinAccessToken();
  if (!token) return null;
  const upload = (accessToken: string) => fetch(`${POKEBIN_BASE}/api/pastes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ data: encodedData, visibility }),
  });
  let res = await upload(token);
  if (res.status === 401) {
    token = await renewPokebinAccessToken(token);
    if (!token) return null;
    res = await upload(token);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PokeBin upload failed: ${res.status} ${txt}`);
  }
  const json = await res.json() as { uuid: string };
  return json.uuid;
}
