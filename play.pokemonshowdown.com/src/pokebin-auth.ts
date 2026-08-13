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

export function getPokebinAccessToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(EXPIRY_KEY);
  if (!token) return null;
  if (expiry && Date.now() > parseInt(expiry, 10)) {
    clearPokebinAuth();
    return null;
  }
  return token;
}

export function isPokebinLoggedIn(): boolean {
  return !!getPokebinAccessToken();
}

export function clearPokebinAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  // also clear any pending verifier/state
  sessionStorage.removeItem('pokebin_verifier');
  sessionStorage.removeItem('pokebin_state');
}

function setPokebinToken(token: string, expiresInSec: number): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresInSec * 1000));
}

export async function connectPokebin(): Promise<string | null> {
  const verifier = randomString(32);
  const challenge = await pkceChallenge(verifier);
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
        const json = await res.json() as { access_token?: string; token_type?: string; expires_in?: number };
        if (!json.access_token || !json.expires_in) {
          console.error('PokeBin token response did not contain an access token', json);
          resolve(null);
          return;
        }
        setPokebinToken(json.access_token, json.expires_in);
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
  const token = getPokebinAccessToken();
  if (!token) return null;
  const res = await fetch(`${POKEBIN_BASE}/api/pastes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ data: encodedData, visibility }),
  });
  if (res.status === 401) {
    clearPokebinAuth();
    return null;
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PokeBin upload failed: ${res.status} ${txt}`);
  }
  const json = await res.json() as { uuid: string };
  return json.uuid;
}
