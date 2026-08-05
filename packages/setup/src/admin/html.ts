/** One deliberately small, dependency-free page for temporary deployment setup. */
export const TENANT_ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentConnect deployment settings</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
    body { max-width: 880px; margin: 48px auto; padding: 0 20px 60px; }
    h1 { margin-bottom: 4px; } h2 { margin-top: 32px; }
    .muted { color: #777; } .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { padding: 8px 13px; cursor: pointer; }
    textarea { width: 100%; min-height: 340px; box-sizing: border-box; font: 13px/1.45 ui-monospace, monospace; }
    input[type=password] { width: min(520px, 100%); padding: 7px; box-sizing: border-box; }
    .secret { margin: 10px 0; } .secret label { display: block; font-family: ui-monospace, monospace; }
    #message { white-space: pre-wrap; padding: 10px 0; min-height: 1.5em; }
    .error { color: #c33; } .ok { color: #198754; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>AgentConnect deployment settings</h1>
  <p class="muted">Temporary operator UI. Saved settings take effect after the stack is restarted.</p>
  <div class="row">
    <button id="login" hidden>Sign in with Logto</button>
    <button id="claim" hidden>Claim ADMIN role</button>
    <button id="copy" hidden>Copy CLI ID token</button>
    <button id="logout" hidden>Forget this session</button>
    <span id="identity" class="muted"></span>
  </div>
  <div id="message" aria-live="polite"></div>

  <section id="editor" hidden>
    <h2>Desired configuration</h2>
    <p class="muted">This is the complete typed non-secret document. Secret fields below are write-only.</p>
    <textarea id="values" spellcheck="false"></textarea>
    <h2>Replace secrets</h2>
    <p class="muted">Leave blank to preserve the stored value.</p>
    <div id="secrets"></div>
    <div class="row"><button id="save">Save configuration</button><span id="revision" class="muted"></span></div>
  </section>

  <script>
    const api = '/api/v1';
    const tokenKey = 'agentconnect.tenant-admin.token';
    const verifierKey = 'agentconnect.tenant-admin.pkce';
    const stateKey = 'agentconnect.tenant-admin.state';
    let currentRevision = 0;
    const secretKeys = [
      'github.privateKeyB64', 'github.webhookSecret', 'github.clientSecret',
      'slack.clientSecret', 'slack.signingSecret', 'logto.managementAppSecret',
      'logto.githubConnectorClientSecret'
    ];
    const el = (id) => document.getElementById(id);
    const message = (text, error = false) => {
      el('message').textContent = text;
      el('message').className = error ? 'error' : 'ok';
    };
    const bearer = () => {
      const token = sessionStorage.getItem(tokenKey);
      return token ? { authorization: 'Bearer ' + token } : {};
    };
    const json = async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.message || ('HTTP ' + response.status)), { status: response.status });
      return body;
    };
    const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

    async function authConfig() { return json(await fetch(api + '/auth-config')); }

    async function signIn() {
      const config = await authConfig();
      if (config.mode !== 'oidc') throw new Error('Save an OIDC configuration first');
      const verifier = random();
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const state = random();
      sessionStorage.setItem(verifierKey, verifier);
      sessionStorage.setItem(stateKey, state);
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('client_id', config.appId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid profile email roles');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (config.resource) url.searchParams.set('resource', config.resource);
      location.assign(url);
    }

    async function finishSignIn() {
      const url = new URL(location.href);
      const code = url.searchParams.get('code');
      if (!code) return;
      const state = url.searchParams.get('state');
      if (!state || state !== sessionStorage.getItem(stateKey)) throw new Error('OIDC state mismatch');
      const verifier = sessionStorage.getItem(verifierKey);
      if (!verifier) throw new Error('PKCE verifier is missing; start sign-in again');
      const config = await authConfig();
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: config.appId,
        redirect_uri: config.redirectUri, code_verifier: verifier
      });
      if (config.resource) body.set('resource', config.resource);
      const tokens = await json(await fetch(config.tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
      }));
      const id = typeof tokens.id_token === 'string' ? tokens.id_token : '';
      if (!id) throw new Error('Logto did not return an ID token');
      sessionStorage.setItem(tokenKey, id);
      sessionStorage.removeItem(verifierKey);
      sessionStorage.removeItem(stateKey);
      history.replaceState({}, '', '/');
    }

    function renderSecrets(statuses) {
      const byKey = new Map((statuses || []).map((item) => [item.key, item]));
      el('secrets').replaceChildren(...secretKeys.map((key) => {
        const status = byKey.get(key);
        const box = document.createElement('div'); box.className = 'secret';
        const label = document.createElement('label');
        label.textContent = key + (status?.configured ? ' (configured, ' + status.fingerprint + ')' : ' (not configured)');
        const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.dataset.key = key;
        box.append(label, input); return box;
      }));
    }

    async function load() {
      const publicAuth = await authConfig();
      const hasToken = Boolean(sessionStorage.getItem(tokenKey));
      el('login').hidden = publicAuth.mode !== 'oidc' || hasToken;
      el('logout').hidden = !hasToken;
      el('copy').hidden = !hasToken;
      el('claim').hidden = publicAuth.mode !== 'oidc' || !publicAuth.claimAvailable || !hasToken;
      try {
        const status = await json(await fetch(api + '/deployment-config', { headers: bearer() }));
        el('editor').hidden = false;
        el('values').value = JSON.stringify(status.values, null, 2);
        currentRevision = status.revision;
        el('revision').textContent = status.configured ? 'revision ' + status.revision : 'not configured';
        renderSecrets(status.secrets);
        message('');
      } catch (error) {
        el('editor').hidden = true;
        if (error.status === 401 || error.status === 403) message('Sign in with a Logto ADMIN account.', true);
        else throw error;
      }
    }

    async function save() {
      const values = JSON.parse(el('values').value);
      const secrets = {};
      for (const input of el('secrets').querySelectorAll('input')) if (input.value) secrets[input.dataset.key] = input.value;
      const saved = await json(await fetch(api + '/deployment-config', {
        method: 'PUT', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ expectedRevision: currentRevision, values, secrets })
      }));
      message('Saved revision ' + saved.revision + '. Restart AgentConnect to apply it.');
      await load();
    }

    async function claim() {
      const result = await json(await fetch(api + '/bootstrap/claim', { method: 'POST', headers: bearer() }));
      sessionStorage.removeItem(tokenKey);
      el('editor').hidden = true;
      el('claim').hidden = true;
      el('copy').hidden = true;
      el('logout').hidden = true;
      el('login').hidden = false;
      message('ADMIN assigned. Sign in again to refresh the role claim.');
    }

    el('login').onclick = () => signIn().catch((error) => message(error.message, true));
    el('claim').onclick = () => claim().catch((error) => message(error.message, true));
    el('copy').onclick = () => {
      const token = sessionStorage.getItem(tokenKey);
      if (!token) return message('Sign in first.', true);
      navigator.clipboard.writeText(token)
        .then(() => message('Copied the short-lived ID token. Export it as TENANT_ADMIN_ID_TOKEN only for this maintenance session.'))
        .catch(() => message('Clipboard access failed; keep CLI writes in this browser session.', true));
    };
    el('logout').onclick = () => { sessionStorage.removeItem(tokenKey); load().catch((error) => message(error.message, true)); };
    el('save').onclick = () => save().catch((error) => message(error.message, true));
    finishSignIn().then(load).catch((error) => message(error.message, true));
  </script>
</body>
</html>`
