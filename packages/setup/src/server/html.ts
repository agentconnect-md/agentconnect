/** One deliberately small, dependency-free deployment administration page. */
export const SETUP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentConnect deployment settings</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
    body { max-width: 1280px; margin: 48px auto; padding: 0 20px 60px; }
    h1 { margin-bottom: 4px; } h2 { margin-top: 32px; } h3 { margin: 0 0 8px; }
    .muted { color: #777; } .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button, .button { padding: 8px 13px; cursor: pointer; }
    .button { border: 1px solid #8888; border-radius: 4px; color: inherit; text-decoration: none; display: inline-block; }
    input, select { width: min(520px, 100%); padding: 7px; box-sizing: border-box; }
    input[type="checkbox"] { width: auto; padding: 0; }
    .field { display: grid; gap: 4px; margin: 10px 0; }
    .provider-stack { display: grid; gap: 16px; }
    .panel { border: 1px solid #8886; border-radius: 8px; padding: 16px; }
    .section-head, .provider-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .section-head h2, .provider-head h3 { margin: 0; }
    .provider-head p { margin: 4px 0 0; }
    .badge { flex: none; border: 1px solid #8886; border-radius: 999px; padding: 3px 9px; font-size: 13px; }
    .badge.pass { color: #198754; border-color: #19875466; background: #19875412; }
    .badge.warn { color: #a66b00; border-color: #d99b1366; background: #d99b1315; }
    .badge.fail { color: #c33; border-color: #c333; background: #c3331111; }
    .credentials { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr); gap: 7px 16px; margin: 16px 0; }
    .credentials dt { color: #777; }
    .credentials dd { margin: 0; overflow-wrap: anywhere; }
    .credentials code { user-select: all; }
    .redacted { font-family: ui-monospace, monospace; letter-spacing: .08em; }
    .secret-line, .value-line { display: flex; gap: 10px; align-items: center; min-height: 30px; }
    .edit-secret { padding: 2px 8px; font-size: 13px; }
    .secret-editor { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
    .secret-editor input { width: min(420px, 100%); }
    .edit-configuration { padding: 2px 8px; font-size: 13px; }
    .startup-owned { color: #777; font-size: 13px; }
    .danger { color: #c33; border-color: #c336; }
    .subsection { margin-top: 16px; padding-top: 14px; border-top: 1px solid #8883; }
    textarea { width: min(720px, 100%); min-height: 100px; padding: 7px; box-sizing: border-box; }
    .uris { margin: 8px 0; padding-left: 20px; } .uris code { user-select: all; }
    .notice { border-left: 4px solid #d99b13; padding: 8px 12px; background: #d99b1315; }
    .diff-title { display: block; margin-bottom: 8px; }
    .config-diff { display: grid; gap: 1px; border: 1px solid #8884; border-radius: 6px; overflow: hidden; background: #8884; }
    .diff-row { display: grid; grid-template-columns: minmax(140px, .8fr) minmax(0, 1.2fr) minmax(0, 1.2fr); background: Canvas; }
    .diff-row > * { min-width: 0; padding: 7px 9px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .diff-head { font-size: 12px; font-weight: 600; color: #777; }
    .diff-field { font-weight: 600; }
    .diff-value { font-family: ui-monospace, monospace; font-size: 13px; }
    pre { padding: 12px; border-radius: 6px; background: #8881; overflow-x: auto; user-select: all; }
    #message { white-space: pre-wrap; padding: 10px 0; min-height: 1.5em; }
    .error { color: #c33; } .ok { color: #198754; } .warn { color: #a66b00; }
    code { overflow-wrap: anywhere; }
    .setup-layout { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 32px; align-items: start; }
    .setup-nav { position: sticky; top: 24px; display: grid; gap: 3px; padding: 10px; border: 1px solid #8886; border-radius: 8px; background: Canvas; }
    .setup-nav a { padding: 7px 9px; border-radius: 5px; color: inherit; text-decoration: none; white-space: nowrap; }
    .setup-nav a:hover { background: #8882; }
    .setup-section { scroll-margin-top: 24px; }
    details.environment { margin: 0 0 24px; } details.environment summary { cursor: pointer; font-weight: 600; }
    @media (max-width: 760px) {
      body { margin-top: 24px; }
      .setup-layout { grid-template-columns: 1fr; gap: 18px; }
      .setup-nav { position: static; display: flex; overflow-x: auto; }
      .credentials { grid-template-columns: 1fr; gap: 2px; }
      .credentials dd { margin-bottom: 8px; }
      .diff-row { grid-template-columns: 1fr; }
      .diff-head { display: none; }
      .diff-value::before { display: block; margin-bottom: 2px; color: #777; font: 11px/1.4 system-ui, sans-serif; }
      .diff-current::before { content: 'Current'; }
      .diff-expected::before { content: 'Expected'; }
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <section id="access">
    <h1>AgentConnect Setup</h1>
    <p id="access-message" class="muted" aria-live="polite">Checking Logto sign-in…</p>
    <div class="row">
      <button id="login" hidden>Sign in with Logto</button>
      <a id="open-logto" class="button" href="http://localhost:3002" target="_blank" rel="noopener" hidden>Open Logto Console</a>
      <button id="show-bootstrap" hidden>Continue setup</button>
    </div>

    <section id="bootstrap" hidden>
      <h2>Set up sign-in</h2>
      <p id="bootstrap-progress" class="muted">Step 1 of 2</p>
      <div id="bootstrap-logto-step" class="panel">
        <h3>Connect Logto</h3>
        <p class="muted">Enter the one-time Logto Management API credential. It is sealed in the deployment database and verified before continuing.</p>
        <label class="field">Logto M2M App ID<input id="logto-app-id" autocomplete="off"></label>
        <label class="field">Logto M2M App Secret<input id="logto-app-secret" type="password" autocomplete="new-password"></label>
        <label class="field">Management API resource<input id="logto-management-api-resource" type="url" autocomplete="off"></label>
        <p class="muted">Logto Cloud uses <code>https://&lt;tenant-id&gt;.logto.app/api</code>. Keep <code>https://default.logto.app/api</code> for Logto OSS.</p>
        <button id="bootstrap-logto-submit">Save Logto and continue</button>
      </div>
      <div id="bootstrap-provider-step" hidden>
        <h3>Choose a sign-in provider</h3>
        <p class="muted">Logto Management API access is ready. Configure one provider to enable sign-in.</p>
        <label class="field">Sign-in provider
          <select id="bootstrap-provider"><option value="google">Google (works on localhost)</option><option value="github">GitHub integration App</option><option id="bootstrap-slack-option" value="slack">Slack integration App</option></select>
        </label>
        <div id="bootstrap-google" class="panel">
          <h3>Google OAuth client</h3>
          <p class="muted">Create a Web application client in Google Auth Platform, then paste its credentials here.</p>
          <p>Authorized JavaScript origin:</p><ul id="bootstrap-google-origins" class="uris"></ul>
          <p>Authorized redirect URIs:</p><ul id="bootstrap-google-redirects" class="uris"></ul>
          <a class="button" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Open Google settings</a>
          <label class="field">Client ID<input id="bootstrap-google-id" autocomplete="off"></label>
          <label class="field">Client Secret<input id="bootstrap-google-secret" type="password" autocomplete="new-password"></label>
          <button id="bootstrap-google-submit">Save Google OAuth and configure Logto</button>
        </div>
        <div id="bootstrap-github" class="panel" hidden>
          <h3>GitHub integration App</h3>
          <p id="bootstrap-github-note" class="muted">This creates one complete App for both GitHub sign-in and repository integration.</p>
          <label class="field">Owner
            <select id="bootstrap-github-owner"><option value="personal">Personal account</option><option value="organization">GitHub organization</option></select>
          </label>
          <label id="bootstrap-github-org-field" class="field" hidden>Organization login<input id="bootstrap-github-org" autocomplete="off"></label>
          <label class="field">App name<input id="bootstrap-github-name" value="AgentConnect"></label>
          <button id="bootstrap-github-submit">Create GitHub App and configure Logto</button>
        </div>
        <div id="bootstrap-slack" class="panel" hidden>
          <h3>Slack integration App</h3>
          <p id="bootstrap-slack-note" class="muted">Creates one complete Slack App for workspace installation and a separate Sign in with Slack OIDC flow.</p>
          <p>Logto redirect URI:</p><ul id="bootstrap-slack-redirects" class="uris"></ul>
          <label class="field">App name<input id="bootstrap-slack-name" value="AgentConnect"></label>
          <label class="field">Temporary App configuration token<input id="bootstrap-slack-token" type="password" autocomplete="new-password"></label>
          <button id="bootstrap-slack-submit">Create Slack App and configure Logto</button>
        </div>
        <button id="bootstrap-back">Back to Logto credentials</button>
      </div>
    </section>
  </section>

  <main id="setup" hidden>
    <div class="setup-layout">
    <nav class="setup-nav" aria-label="Deployment settings">
      <a href="#startup-section">Startup</a>
      <a href="#logto-section">Logto</a>
      <a href="#github-section">GitHub</a>
      <a href="#gitlab-section">GitLab</a>
      <a href="#slack-section">Slack</a>
      <a href="#google-section">Google</a>
      <a href="#feishu-section">Feishu</a>
      <a href="#lark-section">Lark</a>
      <a href="#options-section">Options</a>
    </nav>
    <div class="setup-content">
    <h1>AgentConnect deployment settings</h1>
    <p class="muted">Saved settings take effect after the stack is restarted.</p>
    <div class="row">
      <button id="logout">Log out</button>
    </div>
    <div id="message" aria-live="polite"></div>

    <section id="editor" hidden>
    <details id="startup-section" class="environment setup-section" open>
      <summary>Startup environment</summary>
      <p class="notice">Public service URLs come from <code>.env</code>. Provider callbacks below are derived from these values.</p>
      <pre id="startup-environment"></pre>
    </details>

    <section id="logto-section" class="setup-section" aria-labelledby="logto-heading">
      <div class="section-head">
        <div><h2 id="logto-heading">Logto</h2><p class="muted">Authentication and administrator access.</p></div>
        <span id="logto-match" class="badge">Not checked</span>
      </div>
      <div class="panel">
        <dl class="credentials">
          <dt>Management endpoint</dt><dd class="value-line"><code id="logto-management-endpoint">Not configured</code><span class="startup-owned">startup environment</span></dd>
          <dt>Management App ID</dt><dd class="value-line"><code id="logto-management-id">Not configured</code><button class="edit-configuration" data-provider="logto">Edit</button></dd>
          <dt>Management API resource</dt><dd class="value-line"><code id="logto-management-resource">Not configured</code><button class="edit-configuration" data-provider="logto">Edit</button></dd>
          <dt>Management App secret</dt><dd class="secret-line"><span id="logto-management-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="logto.managementAppSecret" data-secret-display="logto-management-secret-display">Edit</button></dd>
          <dt>Sign-in endpoint</dt><dd class="value-line"><code id="logto-browser-endpoint">Not configured</code><span class="startup-owned">startup environment</span></dd>
          <dt>SPA App ID</dt><dd class="value-line"><code id="logto-browser-id">Not configured</code><button class="edit-configuration" data-provider="logto">Edit</button></dd>
          <dt>Browser API resource</dt><dd class="value-line"><code id="logto-browser-resource">Not configured</code><button class="edit-configuration" data-provider="logto">Edit</button></dd>
        </dl>
        <div id="logto-edit-controls" class="subsection" hidden>
          <h3>Edit Logto configuration</h3>
          <label class="field">Management App ID<input id="logto-edit-management-id" autocomplete="off"></label>
          <label class="field">Management API resource<input id="logto-edit-management-resource" autocomplete="off"></label>
          <label class="field">New Management App secret<input id="logto-edit-management-secret" type="password" autocomplete="new-password" placeholder="Required when management identity changes"></label>
          <label class="field">SPA App ID<input id="logto-edit-browser-id" autocomplete="off"></label>
          <label class="field">Browser API resource<input id="logto-edit-browser-resource" autocomplete="off" placeholder="Optional"></label>
          <div class="row"><button id="save-logto-configuration">Save configuration</button><button id="cancel-logto-configuration">Cancel</button></div>
        </div>
        <p id="logto-status" class="muted">Checking redirects and sign-in settings…</p>
        <div id="logto-drift" class="notice" hidden></div>
        <div class="row">
          <button id="check-logto">Check match</button>
          <button id="reconcile-logto">Apply expected settings</button>
          <a id="logto-settings" class="button" target="_blank" rel="noopener" hidden>Open Logto Console</a>
        </div>
      </div>
    </section>

    <h2>Providers</h2>
    <div class="provider-stack">
      <section id="github-section" class="panel setup-section" aria-labelledby="github-heading">
        <div class="provider-head">
          <div><h3 id="github-heading">GitHub</h3><p class="muted">Repository integration and optional Logto sign-in.</p></div>
          <span id="github-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>App ID</dt><dd class="value-line"><code id="github-app-id">Not configured</code><button class="edit-configuration" data-provider="github">Edit</button></dd>
          <dt>App slug</dt><dd class="value-line"><code id="github-app-slug">Not configured</code><button class="edit-configuration" data-provider="github">Edit</button></dd>
          <dt>Client ID</dt><dd class="value-line"><code id="github-client-id">Not configured</code><button class="edit-configuration" data-provider="github">Edit</button></dd>
          <dt>Webhook delivery</dt><dd class="value-line"><code id="github-webhook-enabled">Not configured</code><button class="edit-configuration" data-provider="github">Edit</button></dd>
          <dt>Client secret</dt><dd class="secret-line"><span id="github-client-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="github.clientSecret" data-secret-display="github-client-secret-display">Edit</button></dd>
          <dt>Private key</dt><dd class="secret-line"><span id="github-private-key-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="github.privateKeyB64" data-secret-display="github-private-key-display">Edit</button></dd>
          <dt>Webhook secret</dt><dd class="secret-line"><span id="github-webhook-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="github.webhookSecret" data-secret-display="github-webhook-secret-display">Edit</button></dd>
          <dt>Logto connector secret</dt><dd class="secret-line"><span id="github-logto-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="logto.githubConnectorClientSecret" data-secret-display="github-logto-secret-display">Edit</button></dd>
        </dl>
        <p id="github-status" class="muted"></p>
        <div id="github-drift" class="notice" hidden></div>
        <div id="github-edit-controls" class="subsection" hidden>
          <h3>Edit GitHub App identity</h3>
          <label class="field">App ID<input id="github-edit-app-id" inputmode="numeric" autocomplete="off"></label>
          <label class="field">App slug<input id="github-edit-slug" autocomplete="off"></label>
          <label class="field">Client ID<input id="github-edit-client-id" autocomplete="off"></label>
          <label><input id="github-edit-webhook-enabled" type="checkbox"> Enable Relay webhook delivery</label>
          <label class="field">New client secret<input id="github-edit-client-secret" type="password" autocomplete="new-password" placeholder="Required when App or Client ID changes"></label>
          <label class="field">New private key (base64)<textarea id="github-edit-private-key" autocomplete="off" placeholder="Required when App ID changes"></textarea></label>
          <label class="field">New webhook secret<input id="github-edit-webhook-secret" type="password" autocomplete="new-password" placeholder="Required when an active webhook App ID changes"></label>
          <label id="github-edit-logto-secret-field" class="field" hidden>New Logto connector client secret<input id="github-edit-logto-secret" type="password" autocomplete="new-password" placeholder="Required when this App is also used for sign-in"></label>
          <div class="row"><button id="save-github-configuration">Save configuration</button><button id="cancel-github-configuration">Cancel</button></div>
        </div>
        <div id="github-create-controls" class="subsection">
          <label class="field">Owner
            <select id="github-owner"><option value="personal">Personal account</option><option value="organization">GitHub organization</option></select>
          </label>
          <label id="github-org-field" class="field" hidden>Organization login<input id="github-org" autocomplete="off"></label>
          <label class="field">App name<input id="github-name" value="AgentConnect"></label>
        </div>
        <div class="row">
          <button id="create-github">Create GitHub App</button>
          <button id="connect-github-login" hidden>Use for Logto sign-in</button>
          <button id="check-github" hidden>Check match</button>
          <button id="clear-github" class="danger" hidden>Clear configuration</button>
          <a id="github-settings" class="button" target="_blank" rel="noopener" hidden>Open GitHub settings</a>
        </div>
      </section>

      <section id="gitlab-section" class="panel setup-section" aria-labelledby="gitlab-heading">
        <div class="provider-head">
          <div><h3 id="gitlab-heading">GitLab</h3><p class="muted">OAuth application used to administer projects on this deployment's GitLab instance.</p></div>
          <span id="gitlab-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>Instance</dt><dd class="value-line"><code id="gitlab-instance">https://gitlab.com</code></dd>
          <dt>Application ID</dt><dd class="value-line"><code id="gitlab-client-id">Not configured</code><button class="edit-configuration" data-provider="gitlab">Edit</button></dd>
          <dt>Secret</dt><dd class="secret-line"><span id="gitlab-client-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="gitlab.clientSecret" data-secret-display="gitlab-client-secret-display">Edit</button></dd>
        </dl>
        <p id="gitlab-status" class="muted"></p>
        <p id="gitlab-probe" class="muted" hidden></p>
        <div id="gitlab-drift" class="notice" hidden></div>
        <p>Redirect URI:</p><ul id="gitlab-callbacks" class="uris"></ul>
        <p>Scopes:</p><ul id="gitlab-scopes" class="uris"></ul>
        <p class="muted">GitLab does not expose OAuth application creation through an API. In User settings &rarr; Applications, or a group's Settings &rarr; Applications, add an application whose redirect URI is exactly the value above, keep Confidential selected, grant the scopes above, then save the generated Application ID and Secret here. GitLab shows the secret only once.</p>
        <p class="muted">Use your own user applications unless you are an instance administrator registering one application for everyone; an instance-wide application lives in the Admin area instead.</p>
        <p class="muted">Creating each agent's bot account later needs authority this page cannot verify — no GitLab API reports it: either connect an instance administrator (whose API token cannot act as one while Admin Mode is enabled), or, on Premium and Ultimate, turn on Admin &rarr; Settings &rarr; General &rarr; Account and limit &rarr; &ldquo;Allow top-level group Owners to create service accounts&rdquo;.</p>
        <div class="row"><a id="gitlab-applications" class="button" href="https://gitlab.com/-/user_settings/applications" target="_blank" rel="noopener">Open GitLab applications</a><a id="gitlab-admin-applications" class="button" href="https://gitlab.com/admin/applications" target="_blank" rel="noopener">Open admin applications</a></div>
        <div id="gitlab-config-controls" class="subsection">
          <label class="field">Instance base URL<input id="gitlab-base-url" autocomplete="off" placeholder="Leave empty for https://gitlab.com"></label>
          <label class="field">Application ID<input id="gitlab-id" autocomplete="off"></label>
          <label id="gitlab-initial-secret-field" class="field">Secret<input id="gitlab-secret" type="password" autocomplete="new-password" placeholder="Required when the Application ID changes"></label>
        </div>
        <div class="row"><button id="save-gitlab">Save GitLab application</button><button id="cancel-gitlab-configuration" hidden>Cancel</button><button id="clear-gitlab" class="danger" hidden>Clear configuration</button></div>
      </section>

      <section id="slack-section" class="panel setup-section" aria-labelledby="slack-heading">
        <div class="provider-head">
          <div><h3 id="slack-heading">Slack</h3><p class="muted">One App for workspace integration and Logto sign-in.</p></div>
          <span id="slack-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>App ID</dt><dd class="value-line"><code id="slack-app-id">Not configured</code><button class="edit-configuration" data-provider="slack">Edit</button></dd>
          <dt>Client ID</dt><dd class="value-line"><code id="slack-client-id">Not configured</code><button class="edit-configuration" data-provider="slack">Edit</button></dd>
          <dt>Client secret</dt><dd class="secret-line"><span id="slack-client-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="slack.clientSecret" data-secret-display="slack-client-secret-display">Edit</button></dd>
          <dt>Signing secret</dt><dd class="secret-line"><span id="slack-signing-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="slack.signingSecret" data-secret-display="slack-signing-secret-display">Edit</button></dd>
          <dt>Logto sign-in</dt><dd id="slack-logto-status">Not configured</dd>
        </dl>
        <p id="slack-status" class="muted"></p>
        <div id="slack-drift" class="notice" hidden></div>
        <div id="slack-edit-controls" class="subsection" hidden>
          <h3>Edit Slack App identity</h3>
          <label class="field">App ID<input id="slack-edit-app-id" autocomplete="off"></label>
          <label class="field">Client ID<input id="slack-edit-client-id" autocomplete="off"></label>
          <label class="field">New client secret<input id="slack-edit-client-secret" type="password" autocomplete="new-password" placeholder="Required when identity changes"></label>
          <label class="field">New signing secret<input id="slack-edit-signing-secret" type="password" autocomplete="new-password" placeholder="Required when identity changes"></label>
          <div class="row"><button id="save-slack-configuration">Save configuration</button><button id="cancel-slack-configuration">Cancel</button></div>
        </div>
        <div class="subsection">
          <label id="slack-name-field" class="field">App name<input id="slack-name" value="AgentConnect"></label>
          <label class="field">Temporary App configuration token<input id="slack-token" type="password" autocomplete="new-password" placeholder="Used only for create or check"></label>
        </div>
        <div class="row">
          <button id="create-slack">Create Slack App</button>
          <button id="connect-slack-login" hidden>Use for Logto sign-in</button>
          <button id="check-slack" hidden>Check match</button>
          <button id="clear-slack" class="danger" hidden>Clear configuration</button>
          <a id="slack-settings" class="button" target="_blank" rel="noopener" hidden>Open Slack settings</a>
        </div>
      </section>

      <section id="google-section" class="panel setup-section" aria-labelledby="google-heading">
        <div class="provider-head">
          <div><h3 id="google-heading">Google</h3><p class="muted">OAuth client used by the Logto Google connector.</p></div>
          <span id="google-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>Client ID</dt><dd class="value-line"><code id="google-client-id">Not configured</code><button class="edit-configuration" data-provider="google">Edit</button></dd>
          <dt>Client secret</dt><dd class="secret-line"><span id="google-client-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="logto.googleConnectorClientSecret" data-secret-display="google-client-secret-display">Edit</button></dd>
        </dl>
        <p id="google-status" class="muted"></p>
        <div id="google-drift" class="notice" hidden></div>
        <p>Authorized JavaScript origin:</p><ul id="google-origins" class="uris"></ul>
        <p>Authorized redirect URIs:</p><ul id="google-redirects" class="uris"></ul>
        <p class="muted">Google does not expose OAuth client redirect settings through an API. Copy these required values into Google Auth Platform; Setup can verify only the Logto connector.</p>
        <div class="row"><a class="button" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Open Google settings</a></div>
        <div id="google-config-controls" class="subsection">
          <label class="field">Client ID<input id="google-id" autocomplete="off"></label>
          <label id="google-initial-secret-field" class="field">Client secret<input id="google-secret" type="password" autocomplete="new-password" placeholder="Required when Client ID changes"></label>
        </div>
        <div class="row"><button id="save-google">Save Google client</button><button id="cancel-google-configuration" hidden>Cancel</button><button id="check-google" hidden>Check match</button><button id="clear-google" class="danger" hidden>Clear configuration</button></div>
      </section>

      <section id="feishu-section" class="panel setup-section" aria-labelledby="feishu-heading">
        <div class="provider-head">
          <div><h3 id="feishu-heading">Feishu</h3><p class="muted">Matches the Logto OAuth 2.0 connector named Feishu, OAuth callbacks, and published App setup.</p></div>
          <span id="feishu-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>App ID</dt><dd class="value-line"><code id="feishu-app-id">Not configured</code><button class="edit-configuration" data-provider="feishu">Edit</button></dd>
          <dt>App secret</dt><dd class="secret-line"><span id="feishu-app-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="feishu.loginAppSecret" data-secret-display="feishu-app-secret-display">Edit</button></dd>
        </dl>
        <p id="feishu-login-status" class="muted"></p>
        <div id="feishu-drift" class="notice" hidden></div>
        <div id="feishu-config-controls" class="subsection">
          <label id="feishu-create-name-field" class="field">New App name<input id="feishu-create-name" value="AgentConnect"></label>
          <label class="field">Existing App ID<input id="feishu-login-id" autocomplete="off"></label>
          <label class="field">Existing App secret<input id="feishu-login-secret" type="password" autocomplete="new-password"></label>
        </div>
        <div class="row">
          <button id="create-feishu-login-app">Create Feishu App</button>
          <button id="save-feishu-login-app">Save existing App</button>
          <button id="cancel-feishu-configuration" hidden>Cancel</button>
          <button id="check-feishu-login-app" hidden>Check setup</button>
          <button id="clear-feishu" class="danger" hidden>Clear configuration</button>
          <a id="feishu-settings" class="button" target="_blank" rel="noopener" hidden>Open Feishu settings</a>
        </div>
      </section>

      <section id="lark-section" class="panel setup-section" aria-labelledby="lark-heading">
        <div class="provider-head">
          <div><h3 id="lark-heading">Lark</h3><p class="muted">Matches the Logto OAuth 2.0 connector named Lark, OAuth callbacks, and published App setup.</p></div>
          <span id="lark-match" class="badge">Not configured</span>
        </div>
        <dl class="credentials">
          <dt>App ID</dt><dd class="value-line"><code id="lark-app-id">Not configured</code><button class="edit-configuration" data-provider="lark">Edit</button></dd>
          <dt>App secret</dt><dd class="secret-line"><span id="lark-app-secret-display" class="redacted">Not configured</span><button class="edit-secret" data-secret-key="lark.loginAppSecret" data-secret-display="lark-app-secret-display">Edit</button></dd>
        </dl>
        <p id="lark-login-status" class="muted"></p>
        <div id="lark-drift" class="notice" hidden></div>
        <div id="lark-config-controls" class="subsection">
          <label id="lark-create-name-field" class="field">New App name<input id="lark-create-name" value="AgentConnect"></label>
          <label class="field">Existing App ID<input id="lark-login-id" autocomplete="off"></label>
          <label class="field">Existing App secret<input id="lark-login-secret" type="password" autocomplete="new-password"></label>
        </div>
        <div class="row">
          <button id="create-lark-login-app">Create Lark App</button>
          <button id="save-lark-login-app">Save existing App</button>
          <button id="cancel-lark-configuration" hidden>Cancel</button>
          <button id="check-lark-login-app" hidden>Check setup</button>
          <button id="clear-lark" class="danger" hidden>Clear configuration</button>
          <a id="lark-settings" class="button" target="_blank" rel="noopener" hidden>Open Lark settings</a>
        </div>
      </section>
    </div>

    <section id="options-section" class="setup-section">
      <h2>Deployment options</h2>
      <div class="panel">
        <label class="field"><span><input id="preset-agents-enabled" type="checkbox"> Enable preset Agents</span></label>
        <label class="field">Max organizations created per non-ADMIN user<input id="max-orgs-per-non-admin-user" type="number" min="0" step="1" value="1"></label>
        <div class="row"><button id="save-options">Save options</button></div>
      </div>
    </section>
    </section>
    </div>
    </div>
  </main>

  <script>
    const api = '/api/v1';
    const tokenKey = 'agentconnect.setup.token';
    const verifierKey = 'agentconnect.setup.pkce';
    const stateKey = 'agentconnect.setup.state';
    let currentRevision = 0;
    let currentStatus = null;
    let bootstrapInfo = null;
    const el = (id) => document.getElementById(id);
    const message = (text, error = false) => {
      const target = el('setup').hidden ? el('access-message') : el('message');
      target.textContent = text;
      target.className = error ? 'error' : 'ok';
    };
    const bearer = () => {
      const token = sessionStorage.getItem(tokenKey);
      return token ? { authorization: 'Bearer ' + token } : {};
    };
    const json = async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.message || ('HTTP ' + response.status)), { status: response.status, code: body.code });
      return body;
    };
    const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
    const configured = (byKey, key) => Boolean(byKey.get(key) && byKey.get(key).configured);

    function showIdentityEditors(provider, show) {
      for (const button of document.querySelectorAll('.edit-configuration[data-provider="' + provider + '"]')) {
        button.hidden = !show;
      }
    }

    function text(id, value) {
      el(id).textContent = value === null || value === undefined || value === '' ? 'Not configured' : String(value);
    }

    function secretText(id, byKey, key, editable) {
      const stored = configured(byKey, key);
      const display = el(id);
      const button = document.querySelector('[data-secret-display="' + id + '"]');
      const row = display.closest('.secret-line');
      const editor = row && row.querySelector('.secret-editor');
      if (editor) editor.remove();
      display.hidden = false;
      display.textContent = stored ? '***' : 'Not configured';
      display.className = stored ? 'redacted' : 'muted';
      button.hidden = !editable;
      button.textContent = stored ? 'Edit' : 'Set';
    }

    function match(id, state, label) {
      const target = el(id);
      target.textContent = label;
      target.className = 'badge' + (state ? ' ' + state : '');
    }

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
      if (typeof tokens.id_token !== 'string') throw new Error('Logto did not return an ID token');
      sessionStorage.setItem(tokenKey, tokens.id_token);
      sessionStorage.removeItem(verifierKey);
      sessionStorage.removeItem(stateKey);
      history.replaceState({}, '', '/');
    }

    function renderUriList(id, values) {
      el(id).replaceChildren(...(values || []).map((value) => {
        const item = document.createElement('li');
        const code = document.createElement('code'); code.textContent = value;
        item.append(code); return item;
      }));
    }

    function updateBootstrapProvider() {
      const provider = el('bootstrap-provider').value;
      el('bootstrap-google').hidden = provider !== 'google';
      el('bootstrap-github').hidden = provider !== 'github';
      el('bootstrap-slack').hidden = provider !== 'slack';
    }

    function showBootstrapStep(step) {
      const logto = step === 'logto';
      el('bootstrap-logto-step').hidden = !logto;
      el('bootstrap-provider-step').hidden = logto;
      el('bootstrap-progress').textContent = logto ? 'Step 1 of 2' : 'Step 2 of 2';
    }

    function updateOwner(prefix) {
      el(prefix + '-org-field').hidden = el(prefix + '-owner').value !== 'organization';
    }

    function ownership(prefix) {
      if (el(prefix + '-owner').value === 'personal') return { owner: 'personal', organization: null };
      const organization = el(prefix + '-org').value.trim();
      if (!organization) throw new Error('Enter the GitHub organization login');
      return { owner: 'organization', organization };
    }

    function formatDiffValue(value) {
      if (value === null || value === undefined || value === '') return 'Not configured';
      if (Array.isArray(value)) return value.length ? value.map(formatDiffValue).join('\n') : '[]';
      if (typeof value === 'object') {
        return Object.entries(value).map(([key, item]) => key + ': ' + (Array.isArray(item) ? item.join(', ') : formatDiffValue(item))).join('\n');
      }
      return String(value);
    }

    function showDiff(id, rows, label = 'Update required') {
      const box = el(id);
      box.hidden = rows.length === 0;
      box.replaceChildren();
      if (rows.length === 0) return;
      const title = document.createElement('strong');
      title.className = 'diff-title';
      title.textContent = label;
      const grid = document.createElement('div');
      grid.className = 'config-diff';
      const head = document.createElement('div');
      head.className = 'diff-row diff-head';
      for (const text of ['Field', 'Current', 'Expected']) {
        const cell = document.createElement('span'); cell.textContent = text; head.append(cell);
      }
      grid.append(head);
      for (const item of rows) {
        const row = document.createElement('div'); row.className = 'diff-row';
        const field = document.createElement('span'); field.className = 'diff-field'; field.textContent = item.field;
        const current = document.createElement('span'); current.className = 'diff-value diff-current'; current.textContent = formatDiffValue(item.current);
        const expected = document.createElement('span'); expected.className = 'diff-value diff-expected'; expected.textContent = formatDiffValue(item.expected);
        row.append(field, current, expected); grid.append(row);
      }
      box.append(title, grid);
    }

    function renderStartupEnvironment() {
      const services = bootstrapInfo.services;
      const environment = [
        ['AGENTCONNECT_PUBLIC_CP_URL', services.controlPlane],
        ['AGENTCONNECT_PUBLIC_RELAY_URL', services.relay],
        ['AGENTCONNECT_PUBLIC_WEB_URL', services.web],
        ['LOGTO_ENDPOINT', bootstrapInfo.logtoEndpoint],
        ['LOGTO_MGMT_ENDPOINT', bootstrapInfo.logtoManagementEndpoint]
      ];
      el('startup-environment').textContent = environment
        .filter(([, value]) => value)
        .map(([key, value]) => key + '=' + value)
        .join('\n');
    }

    function renderApps(status) {
      currentStatus = status;
      const byKey = new Map((status.secrets || []).map((item) => [item.key, item]));
      const values = status.values;
      const expected = status.providerExpectations || { github: null, gitlab: null, slack: null, google: { origins: [], redirects: [] } };
      renderStartupEnvironment();

      const logto = values.logto;
      text('logto-management-endpoint', logto && bootstrapInfo.logtoManagementEndpoint);
      text('logto-management-id', logto && logto.managementAppId);
      text('logto-management-resource', logto && logto.managementResource);
      secretText('logto-management-secret-display', byKey, 'logto.managementAppSecret', Boolean(logto));
      text('logto-browser-endpoint', logto && logto.browser && bootstrapInfo.logtoEndpoint);
      text('logto-browser-id', values.auth.mode === 'oidc' ? values.auth.browserClient.appId : null);
      text('logto-browser-resource', logto && logto.browser && logto.browser.apiResource);
      el('logto-edit-controls').hidden = true;
      showIdentityEditors('logto', Boolean(logto && logto.browser && values.auth.mode === 'oidc'));
      match(
        'logto-match',
        logto && configured(byKey, 'logto.managementAppSecret') ? '' : 'warn',
        logto && configured(byKey, 'logto.managementAppSecret') ? 'Ready to check' : 'Not configured'
      );

      el('preset-agents-enabled').checked = values.features.presetAgentsEnabled;
      el('max-orgs-per-non-admin-user').value = String(values.features.maxOrgsPerNonAdminUser);

      const github = values.github;
      const webhookStored = byKey.get('github.webhookSecret') && byKey.get('github.webhookSecret').configured;
      const webhookInactive = github && github.webhookEnabled === false;
      text('github-app-id', github && github.appId);
      text('github-app-slug', github && github.slug);
      text('github-client-id', github && github.clientId);
      text('github-webhook-enabled', github && (github.webhookEnabled === false ? 'Disabled' : 'Enabled'));
      el('github-edit-controls').hidden = true;
      showIdentityEditors('github', Boolean(github));
      secretText('github-client-secret-display', byKey, 'github.clientSecret', Boolean(github));
      secretText('github-private-key-display', byKey, 'github.privateKeyB64', Boolean(github));
      secretText('github-webhook-secret-display', byKey, 'github.webhookSecret', Boolean(github));
      secretText('github-logto-secret-display', byKey, 'logto.githubConnectorClientSecret', Boolean(values.logto && values.logto.githubConnector));
      el('github-status').textContent = github
        ? github.slug + ' is configured. Webhook secret: ' + (webhookStored ? 'stored' : webhookInactive ? 'not required yet' : 'missing') + '.' +
          (webhookInactive ? ' Relay webhook delivery is disabled.' : '')
        : 'Creates the complete App used for repository installation, webhooks, and optional GitHub sign-in.';
      const githubDrift = github
        ? expected.github
          ? []
          : [{ field: 'Startup public URLs', current: 'Unavailable', expected: 'Valid Web, API, and ingress URLs' }]
        : [];
      match('github-match', !github ? '' : githubDrift.length ? 'warn' : '', !github ? 'Not configured' : githubDrift.length ? 'Expected URLs changed' : 'Ready to check');
      el('github-create-controls').hidden = Boolean(github);
      el('create-github').hidden = Boolean(github);
      el('clear-github').hidden = !github;
      el('connect-github-login').hidden = !github || !values.logto || Boolean(values.logto.githubConnector);
      el('check-github').hidden = !github;
      if (github) showDiff('github-drift', githubDrift, 'Expected URLs changed since App creation');
      else el('github-drift').hidden = true;

      const gitlab = values.gitlab;
      const gitlabSecret = configured(byKey, 'gitlab.clientSecret');
      const expectedGitlab = expected.gitlab;
      renderUriList('gitlab-callbacks', expectedGitlab ? [expectedGitlab.callbackUrl] : []);
      renderUriList('gitlab-scopes', expectedGitlab ? expectedGitlab.scopes : []);
      text('gitlab-client-id', gitlab && gitlab.clientId);
      secretText('gitlab-client-secret-display', byKey, 'gitlab.clientSecret', Boolean(gitlab));
      showIdentityEditors('gitlab', Boolean(gitlab));
      el('gitlab-id').value = gitlab ? gitlab.clientId : '';
      text('gitlab-instance', (gitlab && gitlab.baseUrl) || 'https://gitlab.com');
      // Host-aware application links (§24.1): composed by the server against the
      // configured base, so a path-prefixed install keeps its prefix here too.
      if (expectedGitlab) {
        el('gitlab-applications').href = expectedGitlab.applicationsUrl;
        el('gitlab-admin-applications').href = expectedGitlab.adminApplicationsUrl;
      }
      el('gitlab-base-url').value = (gitlab && gitlab.baseUrl) || '';
      // A probe verdict belongs to the save that produced it, never to a reload.
      el('gitlab-probe').hidden = true;
      el('gitlab-status').textContent = gitlab
        ? gitlab.clientId + ' is configured.'
        : expectedGitlab
          ? 'Register the OAuth application on the configured GitLab instance, then save its Application ID and Secret here.'
          : 'Publishing the redirect URI needs an HTTPS API public URL.';
      showDiff('gitlab-drift', gitlab && !expectedGitlab
        ? [{ field: 'Startup public URLs', current: 'Unavailable', expected: 'An HTTPS API URL' }]
        : []);
      match('gitlab-match', gitlab && gitlabSecret ? 'warn' : '', !gitlab ? 'Not configured' : !gitlabSecret ? 'Missing secret' : "Can't verify automatically");
      el('gitlab-initial-secret-field').hidden = Boolean(gitlab) && gitlabSecret;
      el('gitlab-config-controls').hidden = Boolean(gitlab);
      el('save-gitlab').hidden = Boolean(gitlab);
      el('cancel-gitlab-configuration').hidden = true;
      el('clear-gitlab').hidden = !gitlab;

      const slack = values.slack;
      text('slack-app-id', slack && slack.appId);
      text('slack-client-id', slack && slack.clientId);
      el('slack-edit-controls').hidden = true;
      showIdentityEditors('slack', Boolean(slack));
      secretText('slack-client-secret-display', byKey, 'slack.clientSecret', Boolean(slack));
      secretText('slack-signing-secret-display', byKey, 'slack.signingSecret', Boolean(slack));
      el('slack-logto-status').textContent = values.logto && values.logto.slackConnector
        ? 'Enabled; reuses the Slack client secret above.'
        : 'Not enabled.';
      el('slack-status').textContent = slack ? slack.appId + ' is configured.' : 'Creates the default AgentConnect integration manifest.';
      const slackDrift = slack
        ? expected.slack
          ? []
          : [{ field: 'Startup public URLs', current: 'Unavailable', expected: 'HTTPS Web, API, and ingress URLs' }]
        : [];
      match('slack-match', !slack ? '' : slackDrift.length ? 'warn' : '', !slack ? 'Not configured' : slackDrift.length ? 'Update required' : 'Ready to check');
      el('slack-name-field').hidden = Boolean(slack);
      el('create-slack').hidden = Boolean(slack);
      el('connect-slack-login').hidden = !slack || !values.logto || Boolean(values.logto.slackConnector) || !bootstrapInfo?.slackAvailable;
      el('clear-slack').hidden = !slack;
      el('check-slack').hidden = !slack;
      el('slack-settings').hidden = !slack;
      if (slack) {
        el('slack-settings').href = 'https://api.slack.com/apps/' + encodeURIComponent(slack.appId);
        showDiff('slack-drift', slackDrift);
      } else el('slack-drift').hidden = true;

      const google = values.logto && values.logto.googleConnector;
      const googleSecret = configured(byKey, 'logto.googleConnectorClientSecret');
      const expectedGoogle = expected.google;
      renderUriList('google-origins', expectedGoogle.origins);
      renderUriList('google-redirects', expectedGoogle.redirects);
      text('google-client-id', google && google.clientId);
      secretText('google-client-secret-display', byKey, 'logto.googleConnectorClientSecret', Boolean(google));
      showIdentityEditors('google', Boolean(google));
      el('google-id').value = google ? google.clientId : '';
      el('google-status').textContent = google ? 'Google OAuth client is configured.' : 'Create a Web application OAuth client manually, then save it here.';
      showDiff('google-drift', []);
      match('google-match', google && googleSecret ? 'warn' : '', !google ? 'Not configured' : !googleSecret ? 'Missing secret' : "Can't verify automatically");
      el('google-initial-secret-field').hidden = googleSecret;
      el('save-google').textContent = google ? 'Confirm callback settings' : 'Save Google client';
      el('google-config-controls').hidden = Boolean(google);
      el('save-google').hidden = Boolean(google);
      el('cancel-google-configuration').hidden = true;
      el('check-google').hidden = !google || !googleSecret;
      el('clear-google').hidden = !google;

      const feishuSecret = byKey.get('feishu.loginAppSecret');
      const larkSecret = byKey.get('lark.loginAppSecret');
      el('feishu-login-id').value = values.feishu ? values.feishu.loginAppId : '';
      el('lark-login-id').value = values.lark ? values.lark.loginAppId : '';
      text('feishu-app-id', values.feishu && values.feishu.loginAppId);
      text('lark-app-id', values.lark && values.lark.loginAppId);
      showIdentityEditors('feishu', Boolean(values.feishu));
      showIdentityEditors('lark', Boolean(values.lark));
      secretText('feishu-app-secret-display', byKey, 'feishu.loginAppSecret', Boolean(values.feishu));
      secretText('lark-app-secret-display', byKey, 'lark.loginAppSecret', Boolean(values.lark));
      el('feishu-login-status').textContent = values.feishu && feishuSecret && feishuSecret.configured
        ? values.feishu.loginAppId + ' is configured.'
        : 'No Feishu tenant App is configured.';
      el('lark-login-status').textContent = values.lark && larkSecret && larkSecret.configured
        ? values.lark.loginAppId + ' is configured.'
        : 'No Lark tenant App is configured.';
      match('feishu-match', values.feishu && configured(byKey, 'feishu.loginAppSecret') ? '' : '', values.feishu && configured(byKey, 'feishu.loginAppSecret') ? 'Ready to check' : 'Not configured');
      match('lark-match', values.lark && configured(byKey, 'lark.loginAppSecret') ? '' : '', values.lark && configured(byKey, 'lark.loginAppSecret') ? 'Ready to check' : 'Not configured');
      showDiff('feishu-drift', []);
      showDiff('lark-drift', []);
      el('feishu-config-controls').hidden = Boolean(values.feishu);
      el('lark-config-controls').hidden = Boolean(values.lark);
      el('feishu-create-name-field').hidden = Boolean(values.feishu);
      el('lark-create-name-field').hidden = Boolean(values.lark);
      el('create-feishu-login-app').hidden = Boolean(values.feishu);
      el('create-lark-login-app').hidden = Boolean(values.lark);
      el('save-feishu-login-app').hidden = Boolean(values.feishu);
      el('save-lark-login-app').hidden = Boolean(values.lark);
      el('cancel-feishu-configuration').hidden = true;
      el('cancel-lark-configuration').hidden = true;
      el('clear-feishu').hidden = !values.feishu;
      el('clear-lark').hidden = !values.lark;
      el('check-feishu-login-app').hidden = !values.feishu || !configured(byKey, 'feishu.loginAppSecret');
      el('check-lark-login-app').hidden = !values.lark || !configured(byKey, 'lark.loginAppSecret');
      el('feishu-settings').hidden = !values.feishu;
      el('lark-settings').hidden = !values.lark;
      if (values.feishu) el('feishu-settings').href = 'https://open.feishu.cn/app/' + encodeURIComponent(values.feishu.loginAppId);
      if (values.lark) el('lark-settings').href = 'https://open.larksuite.com/app/' + encodeURIComponent(values.lark.loginAppId);
    }

    function requiredInput(id, label) {
      const value = el(id).value.trim();
      if (!value) throw new Error('Enter ' + label);
      return value;
    }

    function githubConnectorUsesDeployment(values) {
      const github = values.github;
      const connector = values.logto && values.logto.githubConnector;
      return Boolean(
        github && connector &&
        connector.appId === github.appId &&
        connector.slug === github.slug &&
        connector.clientId === github.clientId
      );
    }

    function beginConfigurationEdit(provider) {
      if (!currentStatus) return message('Deployment configuration is not loaded', true);
      const values = currentStatus.values;
      if (provider === 'logto') {
        const logto = values.logto;
        if (!logto || !logto.browser || values.auth.mode !== 'oidc') return;
        el('logto-edit-management-id').value = logto.managementAppId;
        el('logto-edit-management-resource').value = logto.managementResource;
        el('logto-edit-management-secret').value = '';
        el('logto-edit-browser-id').value = values.auth.browserClient.appId;
        el('logto-edit-browser-resource').value = logto.browser.apiResource || '';
        el('logto-edit-controls').hidden = false;
        el('logto-edit-management-id').focus();
      } else if (provider === 'github') {
        const github = values.github;
        if (!github) return;
        el('github-edit-app-id').value = String(github.appId);
        el('github-edit-slug').value = github.slug;
        el('github-edit-client-id').value = github.clientId || '';
        el('github-edit-webhook-enabled').checked = github.webhookEnabled !== false;
        for (const id of ['github-edit-client-secret', 'github-edit-private-key', 'github-edit-webhook-secret', 'github-edit-logto-secret']) el(id).value = '';
        el('github-edit-logto-secret-field').hidden = !githubConnectorUsesDeployment(values);
        el('github-edit-controls').hidden = false;
        el('clear-github').hidden = true;
        el('github-edit-app-id').focus();
      } else if (provider === 'slack') {
        const slack = values.slack;
        if (!slack) return;
        el('slack-edit-app-id').value = slack.appId;
        el('slack-edit-client-id').value = slack.clientId;
        el('slack-edit-client-secret').value = '';
        el('slack-edit-signing-secret').value = '';
        el('slack-edit-controls').hidden = false;
        el('clear-slack').hidden = true;
        el('slack-edit-app-id').focus();
      } else if (provider === 'gitlab') {
        if (!values.gitlab) return;
        el('gitlab-id').value = values.gitlab.clientId;
        el('gitlab-secret').value = '';
        el('gitlab-config-controls').hidden = false;
        el('gitlab-initial-secret-field').hidden = false;
        el('save-gitlab').hidden = false;
        el('cancel-gitlab-configuration').hidden = false;
        el('clear-gitlab').hidden = true;
        el('gitlab-id').focus();
      } else if (provider === 'google') {
        const google = values.logto && values.logto.googleConnector;
        if (!google) return;
        el('google-id').value = google.clientId;
        el('google-secret').value = '';
        el('google-config-controls').hidden = false;
        el('google-initial-secret-field').hidden = false;
        el('save-google').hidden = false;
        el('save-google').textContent = 'Save Google client';
        el('cancel-google-configuration').hidden = false;
        el('clear-google').hidden = true;
        el('google-id').focus();
      } else if (provider === 'feishu' || provider === 'lark') {
        el(provider + '-config-controls').hidden = false;
        el(provider + '-create-name-field').hidden = true;
        el('create-' + provider + '-login-app').hidden = true;
        el('save-' + provider + '-login-app').hidden = false;
        el('cancel-' + provider + '-configuration').hidden = false;
        el('clear-' + provider).hidden = true;
        el(provider + '-login-secret').value = '';
        el(provider + '-login-id').focus();
      }
      showIdentityEditors(provider, false);
    }

    function cancelConfigurationEdit() {
      if (currentStatus) renderApps(currentStatus);
    }

    async function replaceConfiguration(values, secrets, successMessage) {
      const response = await json(await fetch(api + '/deployment-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ expectedRevision: currentRevision, values, ...(secrets ? { secrets } : {}) })
      }));
      await load();
      message(successMessage || 'Configuration saved. Restart AgentConnect to apply it.');
      return response;
    }

    async function saveLogtoConfiguration() {
      if (!currentStatus) throw new Error('Deployment configuration is not loaded');
      const values = currentStatus.values;
      const logto = values.logto;
      if (!logto || !logto.browser || values.auth.mode !== 'oidc') throw new Error('Logto is not configured');
      const managementAppId = requiredInput('logto-edit-management-id', 'the Management App ID');
      const managementResource = requiredInput('logto-edit-management-resource', 'the Management API resource');
      const browserAppId = requiredInput('logto-edit-browser-id', 'the SPA App ID');
      const browserResource = el('logto-edit-browser-resource').value.trim() || null;
      const managementIdentityChanged = managementAppId !== logto.managementAppId;
      const managementSecret = el('logto-edit-management-secret').value;
      if (managementIdentityChanged && !managementSecret) throw new Error('Enter the new Management App secret');
      const browser = { ...logto.browser, apiResource: browserResource };
      const auth = {
        ...values.auth,
        audience: browserResource || browserAppId,
        browserClient: { appId: browserAppId, apiResource: browserResource }
      };
      await replaceConfiguration(
        {
          ...values,
          auth,
          logto: { ...logto, managementAppId, managementResource, browser }
        },
        managementSecret ? { 'logto.managementAppSecret': managementSecret } : undefined,
        'Logto configuration saved. Sign in again if the SPA identity changed, then restart AgentConnect.'
      );
    }

    async function saveGithubConfiguration() {
      if (!currentStatus || !currentStatus.values.github) throw new Error('GitHub is not configured');
      const values = currentStatus.values;
      const previous = values.github;
      const appId = Number(requiredInput('github-edit-app-id', 'the GitHub App ID'));
      if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App ID must be a positive integer');
      const slug = requiredInput('github-edit-slug', 'the GitHub App slug');
      const clientId = requiredInput('github-edit-client-id', 'the GitHub Client ID');
      const appChanged = appId !== previous.appId;
      const clientChanged = clientId !== previous.clientId;
      const webhookEnabled = el('github-edit-webhook-enabled').checked;
      const webhookEnabling = webhookEnabled && previous.webhookEnabled === false;
      const connectorReused = githubConnectorUsesDeployment(values);
      const clientSecret = el('github-edit-client-secret').value;
      const privateKey = el('github-edit-private-key').value.trim();
      const webhookSecret = el('github-edit-webhook-secret').value;
      const connectorSecret = el('github-edit-logto-secret').value;
      const webhookSecretStored = currentStatus.secrets.some((secret) => secret.key === 'github.webhookSecret' && secret.configured);
      if ((appChanged || clientChanged) && !clientSecret) throw new Error('Enter the new GitHub client secret');
      if (appChanged && !privateKey) throw new Error('Enter the new GitHub private key as base64');
      if (webhookEnabled && ((appChanged && !webhookSecret) || (webhookEnabling && !webhookSecret && !webhookSecretStored))) throw new Error('Enter the new GitHub webhook secret');
      if (connectorReused && (appChanged || clientChanged) && !connectorSecret) throw new Error('Enter the new Logto connector client secret');
      const secrets = {};
      if (clientSecret) secrets['github.clientSecret'] = clientSecret;
      if (privateKey) secrets['github.privateKeyB64'] = privateKey;
      if (webhookSecret) secrets['github.webhookSecret'] = webhookSecret;
      if (connectorSecret) secrets['logto.githubConnectorClientSecret'] = connectorSecret;
      const nextLogto = connectorReused && values.logto
        ? { ...values.logto, githubConnector: { ...values.logto.githubConnector, appId, slug, clientId } }
        : values.logto;
      await replaceConfiguration(
        {
          ...values,
          github: { ...previous, appId, slug, clientId, webhookEnabled },
          ...(nextLogto ? { logto: nextLogto } : {})
        },
        Object.keys(secrets).length ? secrets : undefined,
        'GitHub App identity saved. Restart AgentConnect to apply it.'
      );
      if (connectorSecret) {
        await reconcileLogto(true);
        await load();
      }
    }

    async function saveSlackConfiguration() {
      if (!currentStatus || !currentStatus.values.slack) throw new Error('Slack is not configured');
      const values = currentStatus.values;
      const previous = values.slack;
      const appId = requiredInput('slack-edit-app-id', 'the Slack App ID');
      const clientId = requiredInput('slack-edit-client-id', 'the Slack Client ID');
      const changed = appId !== previous.appId || clientId !== previous.clientId;
      const clientSecret = el('slack-edit-client-secret').value;
      const signingSecret = el('slack-edit-signing-secret').value;
      if (changed && (!clientSecret || !signingSecret)) throw new Error('Enter both the new Slack client secret and signing secret');
      const secrets = {};
      if (clientSecret) secrets['slack.clientSecret'] = clientSecret;
      if (signingSecret) secrets['slack.signingSecret'] = signingSecret;
      const nextLogto = values.logto && values.logto.slackConnector
        ? { ...values.logto, slackConnector: { ...values.logto.slackConnector, appId, clientId } }
        : values.logto;
      await replaceConfiguration(
        {
          ...values,
          slack: { ...previous, appId, clientId },
          ...(nextLogto ? { logto: nextLogto } : {})
        },
        Object.keys(secrets).length ? secrets : undefined,
        'Slack App identity saved. Restart AgentConnect to apply it.'
      );
      if (clientSecret && nextLogto && nextLogto.slackConnector) {
        await reconcileLogto(true);
        await load();
      }
    }

    async function clearProvider(provider) {
      if (!currentStatus) throw new Error('Deployment configuration is not loaded');
      const label = provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : provider === 'slack' ? 'Slack' : provider === 'google' ? 'Google' : provider === 'feishu' ? 'Feishu' : 'Lark';
      if (!window.confirm('Clear the saved ' + label + ' configuration and secrets?')) return;
      const values = currentStatus.values;
      let next = values;
      let secrets = {};
      if (provider === 'github') {
        const connectorReused = githubConnectorUsesDeployment(values);
        const logto = connectorReused && values.logto
          ? {
              ...values.logto,
              githubConnector: null
            }
          : values.logto;
        next = { ...values, github: null, ...(logto ? { logto } : {}) };
        secrets = {
          'github.clientSecret': null,
          'github.privateKeyB64': null,
          'github.webhookSecret': null,
          ...(connectorReused ? { 'logto.githubConnectorClientSecret': null } : {})
        };
      } else if (provider === 'gitlab') {
        next = { ...values, gitlab: null };
        secrets = { 'gitlab.clientSecret': null };
      } else if (provider === 'slack') {
        const logto = values.logto
          ? {
              ...values.logto,
              browser: values.logto.browser
                ? { ...values.logto.browser, socialProviders: values.logto.browser.socialProviders.filter((item) => item !== 'slack') }
                : values.logto.browser,
              slackConnector: null
            }
          : values.logto;
        next = { ...values, slack: null, ...(logto ? { logto } : {}) };
        secrets = { 'slack.clientSecret': null, 'slack.signingSecret': null };
      } else if (provider === 'google') {
        if (!values.logto) return;
        next = {
          ...values,
          logto: {
            ...values.logto,
            browser: values.logto.browser
              ? { ...values.logto.browser, socialProviders: values.logto.browser.socialProviders.filter((item) => item !== 'google') }
              : values.logto.browser,
            googleConnector: null
          }
        };
        secrets = { 'logto.googleConnectorClientSecret': null };
      } else if (provider === 'feishu' || provider === 'lark') {
        next = { ...values, [provider]: null };
        secrets = { [provider + '.loginAppSecret']: null };
      }
      await replaceConfiguration(next, secrets, label + ' configuration cleared. Its setup controls are available again.');
    }

    async function startGithub(prefix) {
      const result = await json(await fetch(api + '/create/github/start', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({
          purpose: 'deployment',
          name: el(prefix + '-name').value,
          ownership: ownership(prefix),
          connectLogto: prefix === 'bootstrap-github'
        })
      }));
      const form = document.createElement('form');
      form.method = 'post'; form.action = result.action;
      const manifest = document.createElement('input');
      manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest);
      form.append(manifest); document.body.append(form);
      message('Opening GitHub to review the complete integration App.');
      form.submit();
    }

    async function loadBootstrapInfo() {
      bootstrapInfo = await json(await fetch(api + '/bootstrap-info'));
      el('open-logto').href = bootstrapInfo.logtoAdminEndpoint;
      el('logto-settings').href = bootstrapInfo.logtoAdminEndpoint;
      if (!el('logto-app-id').value && bootstrapInfo.logtoManagementAppId) {
        el('logto-app-id').value = bootstrapInfo.logtoManagementAppId;
      }
      renderUriList('bootstrap-google-origins', bootstrapInfo.google.javascriptOrigins);
      renderUriList('bootstrap-google-redirects', bootstrapInfo.google.redirectUris);
      renderUriList('bootstrap-slack-redirects', [bootstrapInfo.slackLoginRedirectUrl]);
      el('logto-management-api-resource').value = bootstrapInfo.logtoManagementResource;
      el('bootstrap-github-submit').disabled = !bootstrapInfo.githubAvailable;
      if (!bootstrapInfo.githubAvailable) {
        el('bootstrap-github-note').textContent = 'GitHub App creation needs valid saved Web, API, and ingress URLs.';
      } else if (!bootstrapInfo.githubWebhookActive) {
        el('bootstrap-github-note').textContent = 'Creates the complete GitHub App now without submitting the localhost webhook URL. Add it after saving reachable HTTPS ingress.';
      } else {
        el('bootstrap-github-note').textContent = 'This creates one complete App for both GitHub sign-in and repository integration.';
      }
      el('bootstrap-slack-option').disabled = !bootstrapInfo.slackAvailable;
      el('bootstrap-slack-submit').disabled = !bootstrapInfo.slackAvailable;
      el('bootstrap-slack-note').textContent = bootstrapInfo.slackAvailable
        ? 'Creates one complete Slack App. Sign-in uses a separate openid profile email flow from workspace installation.'
        : 'Slack sign-in needs all public service URLs to use HTTPS. Use Google locally or expose the stack through trusted HTTPS endpoints.';
      if (!bootstrapInfo.slackAvailable && el('bootstrap-provider').value === 'slack') {
        el('bootstrap-provider').value = 'google';
        updateBootstrapProvider();
      }
      return bootstrapInfo;
    }

    async function logtoBootstrapFinding() {
      const report = await json(await fetch(api + '/check/logto', { headers: bearer() }));
      for (const id of ['logto.client_credentials', 'logto.roles_read']) {
        const finding = report.findings.find((candidate) => candidate.id === id);
        if (!finding || finding.status !== 'pass') {
          return finding || { status: 'fail', message: 'Logto Management API permissions could not be verified.' };
        }
      }
      return { status: 'pass', message: 'Logto Management API access is ready.' };
    }

    async function showBootstrap() {
      el('bootstrap').hidden = false;
      el('show-bootstrap').hidden = true;
      const info = bootstrapInfo || await loadBootstrapInfo();
      if (!info.logtoConfigured) {
        showBootstrapStep('logto');
        return;
      }
      const finding = await logtoBootstrapFinding();
      if (finding && finding.status === 'pass') {
        showBootstrapStep('provider');
        message('Logto Management API access is ready. Choose a sign-in provider.');
        return;
      }
      showBootstrapStep('logto');
      message(finding?.message || 'Logto Management API credentials could not be verified.', true);
    }

    async function bootstrapLogto() {
      await json(await fetch(api + '/bootstrap/logto', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          managementAppId: el('logto-app-id').value,
          managementAppSecret: el('logto-app-secret').value,
          managementResource: el('logto-management-api-resource').value
        })
      }));
      el('logto-app-secret').value = '';
      await loadBootstrapInfo();
      const finding = await logtoBootstrapFinding();
      if (!finding || finding.status !== 'pass') {
        throw new Error(finding?.message || 'Logto Management API credentials could not be verified.');
      }
      showBootstrapStep('provider');
      message('Logto Management API access is ready. Choose a sign-in provider.');
    }

    async function bootstrapGoogle() {
      const secret = el('bootstrap-google-secret').value;
      await json(await fetch(api + '/configure/google', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: el('bootstrap-google-id').value, clientSecret: secret })
      }));
      el('bootstrap-google-secret').value = '';
      await reconcileLogto(true);
      await load();
    }

    async function bootstrapGithub() {
      if (!bootstrapInfo || !bootstrapInfo.githubAvailable) throw new Error('GitHub App creation needs valid saved Web, API, and ingress URLs.');
      await startGithub('bootstrap-github');
    }

    async function bootstrapSlack() {
      if (!bootstrapInfo || !bootstrapInfo.slackAvailable) throw new Error('Slack sign-in requires all public service URLs to use HTTPS.');
      await createSlack('bootstrap-slack', true);
      await reconcileLogto();
      await load();
    }

    async function createSlack(prefix = 'slack', connectLogto = false) {
      const result = await json(await fetch(api + '/create/slack', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({
          name: el(prefix + '-name').value,
          configToken: el(prefix + '-token').value,
          connectLogto
        })
      }));
      el(prefix + '-token').value = '';
      if (!connectLogto) await load();
      message('Slack App ' + result.app.id + ' was created with the default integration manifest. Restart AgentConnect to apply it.');
    }

    async function checkGithub() {
      const result = await json(await fetch(api + '/check/github', { headers: bearer() }));
      el('github-settings').href = result.settingsUrl;
      el('github-settings').hidden = false;
      const label = result.missing.length ? 'Update required' : "Can't verify automatically";
      showDiff('github-drift', result.diff || [], label);
      match('github-match', result.status === 'pass' ? 'pass' : 'warn', result.status === 'pass' ? 'Matches' : label);
      message(result.status === 'pass' ? 'GitHub App matches the expected integration manifest.' : result.missing.length ? 'GitHub App settings need an update.' : "GitHub can't expose callback, setup, or webhook-active settings through its API; check them in GitHub.", result.status === 'fail');
    }

    async function connectGithubLogin() {
      await json(await fetch(api + '/configure/github-login', { method: 'POST', headers: bearer() }));
      await reconcileLogto();
      await load();
      message('The deployment GitHub App is now also used for Logto sign-in. Update its displayed callback URLs.');
    }

    async function connectSlackLogin() {
      if (!currentStatus || !currentStatus.values.slack || !currentStatus.values.logto) {
        throw new Error('Save the Slack App and Logto configuration first');
      }
      const values = currentStatus.values;
      const slack = values.slack;
      const logto = values.logto;
      await replaceConfiguration(
        {
          ...values,
          logto: {
            ...logto,
            browser: logto.browser
              ? { ...logto.browser, socialProviders: [...new Set([...logto.browser.socialProviders, 'slack'])] }
              : logto.browser,
            slackConnector: {
              appId: slack.appId,
              clientId: slack.clientId
            }
          }
        },
        undefined,
        'Slack App is ready to connect to Logto.'
      );
      await reconcileLogto();
      await load();
      message('The deployment Slack App is now also used for Logto sign-in.');
    }

    async function checkSlack() {
      const token = requiredInput('slack-token', 'the temporary Slack App configuration token');
      const result = await json(await fetch(api + '/check/slack', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ configToken: token })
      }));
      el('slack-token').value = '';
      showDiff('slack-drift', result.diff || []);
      match('slack-match', result.status === 'pass' ? 'pass' : 'warn', result.status === 'pass' ? 'Matches' : 'Update required');
      message(result.status === 'pass' ? 'Slack App matches the default integration manifest.' : 'Slack App settings need an update.', result.status !== 'pass');
    }

    async function checkGoogle() {
      const report = await checkLogto();
      const connector = report.findings.find((finding) => finding.id === 'logto.connectors');
      const google = currentStatus && currentStatus.values.logto && currentStatus.values.logto.googleConnector;
      const connectorDiff = connector && connector.diff
        ? connector.diff.filter((item) => item.field.toLowerCase().startsWith('google'))
        : [];
      const passed = Boolean(google && connector && connectorDiff.length === 0);
      showDiff('google-drift', connectorDiff);
      match('google-match', passed ? 'pass' : 'warn', passed ? 'Logto matches' : 'Update required');
      message(
        passed
          ? "The Logto Google connector matches. Google OAuth redirect settings can't be verified automatically."
          : 'The Logto Google connector needs an update.',
        !passed
      );
    }

    async function checkRegionalLoginApp(region) {
      const result = await json(await fetch(api + '/check/regional-login-app/' + region, { headers: bearer() }));
      const label = region === 'feishu' ? 'Feishu' : 'Lark';
      showDiff(region + '-drift', result.diff || []);
      match(region + '-match', result.status === 'pass' ? 'pass' : result.status === 'fail' ? 'fail' : 'warn', result.status === 'pass' ? 'Matches' : result.status === 'fail' ? 'Update required' : 'Could not check');
      el(region + '-login-status').textContent = result.message;
      el(region + '-login-status').className = result.status === 'pass' ? 'ok' : result.status === 'fail' ? 'warn' : 'muted';
      message(result.message || (label + ' credential check completed.'), result.status === 'fail');
    }

    async function saveGitlab() {
      const clientSecret = el('gitlab-secret').value;
      const baseUrl = el('gitlab-base-url').value.trim();
      const saved = await json(await fetch(api + '/configure/gitlab', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({
          application: {
            clientId: requiredInput('gitlab-id', 'the GitLab Application ID'),
            ...(clientSecret ? { clientSecret } : {}),
            ...(baseUrl ? { baseUrl } : {})
          }
        })
      }));
      el('gitlab-secret').value = '';
      await load();
      showGitlabProbe(saved.probe);
      message('GitLab OAuth application saved. Restart AgentConnect to apply it.');
    }

    // Only the URL shape blocks the save, so every other verdict is a line to read.
    function showGitlabProbe(probe) {
      const line = el('gitlab-probe');
      line.hidden = !probe;
      line.textContent = probe ? probe.message : '';
    }

    async function saveGoogle() {
      const secret = el('google-secret').value;
      await json(await fetch(api + '/configure/google', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({
          clientId: el('google-id').value,
          ...(secret ? { clientSecret: secret } : {})
        })
      }));
      el('google-secret').value = '';
      await reconcileLogto(Boolean(secret));
      await load();
      message('Google OAuth client and Logto connector are configured. Restart AgentConnect to apply the saved settings.');
    }

    function regionalLoginApp(prefix) {
      const appId = el(prefix + '-login-id').value.trim();
      const appSecret = el(prefix + '-login-secret').value;
      return appId ? { appId, ...(appSecret ? { appSecret } : {}) } : null;
    }

    async function saveRegionalLoginApp(region) {
      const app = regionalLoginApp(region);
      if (!app) throw new Error('Enter the ' + (region === 'feishu' ? 'Feishu' : 'Lark') + ' App ID');
      await json(await fetch(api + '/configure/regional-login-app', {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ region, app })
      }));
      el(region + '-login-secret').value = '';
      await load();
      message((region === 'feishu' ? 'Feishu' : 'Lark') + ' tenant App is saved. Restart AgentConnect services to apply it.');
    }

    async function createRegionalLoginApp(region) {
      const popup = window.open('about:blank', '_blank');
      try {
        const started = await json(await fetch(api + '/create/regional-login-app/start', {
          method: 'POST', headers: { 'content-type': 'application/json', ...bearer() },
          body: JSON.stringify({ region, name: el(region + '-create-name').value })
        }));
        if (popup) popup.location.replace(started.authorizationUrl);
        else window.open(started.authorizationUrl, '_blank', 'noopener');
        message('Approve the new ' + (region === 'feishu' ? 'Feishu' : 'Lark') + ' App in the opened page. This page will finish saving it automatically.');
        while (true) {
          const result = await json(await fetch(api + '/create/regional-login-app/' + encodeURIComponent(started.id), { headers: bearer() }));
          if (result.status === 'completed') {
            await load();
            message((region === 'feishu' ? 'Feishu' : 'Lark') + ' App ' + result.appId + ' was created and saved. Restart AgentConnect services to apply it.');
            return;
          }
          if (result.status === 'failed') throw new Error('Regional App creation ' + result.reason + '. Start it again.');
          await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(result.retryAfterMs || 2000, 5000))));
        }
      } catch (error) {
        if (popup) popup.close();
        throw error;
      }
    }

    async function reconcileLogto(refreshConnectorSecrets) {
      return json(await fetch(api + '/reconcile/logto', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ refreshConnectorSecrets: Boolean(refreshConnectorSecrets) })
      }));
    }

    async function refreshDeploymentConfig() {
      const status = await json(await fetch(api + '/deployment-config', { headers: bearer() }));
      el('access').hidden = true;
      el('setup').hidden = false;
      el('editor').hidden = false;
      currentRevision = status.revision;
      renderApps(status);
      return status;
    }

    async function checkLogto() {
      const report = await json(await fetch(api + '/check/logto', { headers: bearer() }));
      await refreshDeploymentConfig();
      const failures = report.findings.filter((finding) => finding.status !== 'pass');
      el('logto-status').textContent = failures.length === 0
        ? 'SPA redirects, connectors, and social-only sign-in match.'
        : failures.map((finding) => finding.message).join(' ');
      el('logto-status').className = failures.length === 0 ? 'ok' : 'warn';
      match('logto-match', failures.length === 0 ? 'pass' : 'warn', failures.length === 0 ? 'Matches' : 'Update required');
      showDiff(
        'logto-drift',
        failures.flatMap((finding) => finding.diff && finding.diff.length
          ? finding.diff
          : [{ field: finding.id.replace(/^logto\./, '').replaceAll('_', ' '), current: finding.message, expected: 'Matches expected configuration' }])
      );
      el('logto-settings').hidden = failures.length === 0;
      return report;
    }

    function githubNotice(value) {
      if (value === 'deployment-created') return 'GitHub integration App created. Its private key and webhook secret are stored.';
      if (value === 'deployment-login-created') return 'GitHub integration App created and connected to Logto sign-in.';
      if (value === 'cancelled') return 'GitHub App creation was cancelled.';
      if (value === 'expired') return 'GitHub App creation expired. Start it again.';
      if (value === 'invalid-callback') return 'GitHub returned an invalid App creation callback.';
      if (value === 'conversion-failed') return 'GitHub may have created the App, but did not return complete credentials. Delete the orphaned App and retry.';
      if (value === 'save-failed') return 'GitHub created the App, but its credentials could not be saved. Delete the orphaned App and retry.';
      return '';
    }

    async function load() {
      let publicAuth = await authConfig();
      const currentUrl = new URL(location.href);
      const githubResult = currentUrl.searchParams.get('github');
      const notice = githubNotice(githubResult);
      if (githubResult === 'deployment-login-created' && publicAuth.mode === 'none') {
        await reconcileLogto();
        publicAuth = await authConfig();
      }
      if (githubResult) history.replaceState({}, '', '/');
      const hasToken = Boolean(sessionStorage.getItem(tokenKey));
      el('access').hidden = false;
      el('setup').hidden = true;
      el('login').hidden = true;
      el('open-logto').hidden = true;
      el('show-bootstrap').hidden = true;
      el('editor').hidden = true;
      el('bootstrap').hidden = true;
      if (publicAuth.logtoAdminEndpoint) {
        el('open-logto').href = publicAuth.logtoAdminEndpoint;
        el('logto-settings').href = publicAuth.logtoAdminEndpoint;
      }
      if (publicAuth.mode === 'none') {
        sessionStorage.removeItem(tokenKey);
        await loadBootstrapInfo();
        el('open-logto').hidden = false;
        el('show-bootstrap').hidden = false;
        message(notice || 'Logto sign-in is not configured. Set up the initial Logto administrator first.');
        return;
      }
      if (publicAuth.mode === 'unavailable') {
        el('open-logto').hidden = false;
        message(publicAuth.message || 'Logto sign-in is unavailable. Open Logto Console to review its settings.', true);
        return;
      }
      if (!hasToken) {
        el('login').hidden = false;
        message(notice || 'Sign in with Logto to continue.');
        return;
      }
      if (publicAuth.claimAvailable) {
        try {
          await json(await fetch(api + '/bootstrap/claim', { method: 'POST', headers: bearer() }));
          sessionStorage.removeItem(tokenKey);
          el('login').hidden = false;
          message('This first user is now an ADMIN. Sign in again to refresh the role claim.');
          return;
        } catch (error) {
          if (error.status !== 401 && error.status !== 403) throw error;
          sessionStorage.removeItem(tokenKey);
          el('login').hidden = false;
          message('Sign in with Logto to continue.', true);
          return;
        }
      }
      try {
        await loadBootstrapInfo();
        await refreshDeploymentConfig();
        message(notice);
        checkLogto().catch((error) => {
          el('logto-status').textContent = error.message;
          el('logto-status').className = 'warn';
          el('logto-settings').hidden = false;
        });
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          sessionStorage.removeItem(tokenKey);
          el('login').hidden = false;
          message('Sign in with a Logto ADMIN account.', true);
        }
        else throw error;
      }
    }

    async function saveSecretReplacement(key, value) {
      if (!currentStatus) throw new Error('Deployment configuration is not loaded');
      if (!value) throw new Error('Enter the replacement secret');
      const refreshLogto =
        (key === 'logto.githubConnectorClientSecret' && currentStatus.values.logto && currentStatus.values.logto.githubConnector) ||
        (key === 'logto.googleConnectorClientSecret' && currentStatus.values.logto && currentStatus.values.logto.googleConnector) ||
        (key === 'slack.clientSecret' && currentStatus.values.logto && currentStatus.values.logto.slackConnector);
      await json(await fetch(api + '/deployment-config', {
        method: 'PUT', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ expectedRevision: currentRevision, values: currentStatus.values, secrets: { [key]: value } })
      }));
      try {
        if (refreshLogto) await reconcileLogto(true);
      } finally {
        await load();
      }
      if (refreshLogto) {
        message('Secret replaced and applied to the Logto connector. Restart AgentConnect to apply deployment changes.');
      } else {
        message('Secret replaced. Restart AgentConnect to apply it.');
      }
    }

    function editSecret(button) {
      if (!currentStatus) return message('Deployment configuration is not loaded', true);
      const row = button.closest('.secret-line');
      const display = el(button.dataset.secretDisplay);
      if (!row || !display || row.querySelector('.secret-editor')) return;
      const editor = document.createElement('span'); editor.className = 'secret-editor';
      const input = document.createElement('input');
      input.type = 'password'; input.autocomplete = 'new-password'; input.placeholder = 'Enter replacement secret';
      const save = document.createElement('button'); save.textContent = 'Save';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      const close = () => { editor.remove(); display.hidden = false; button.hidden = false; };
      save.onclick = async () => {
        save.disabled = true;
        try { await saveSecretReplacement(button.dataset.secretKey, input.value); }
        catch (error) { save.disabled = false; message(error.message, true); }
      };
      cancel.onclick = close;
      input.onkeydown = (event) => { if (event.key === 'Enter') save.click(); if (event.key === 'Escape') close(); };
      display.hidden = true; button.hidden = true;
      editor.append(input, save, cancel); row.append(editor); input.focus();
    }

    async function saveOptions() {
      if (!currentStatus) throw new Error('Deployment configuration is not loaded');
      const values = {
        ...currentStatus.values,
        features: {
          presetAgentsEnabled: el('preset-agents-enabled').checked,
          maxOrgsPerNonAdminUser: Number(el('max-orgs-per-non-admin-user').value)
        }
      };
      const saved = await json(await fetch(api + '/deployment-config', {
        method: 'PUT', headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ expectedRevision: currentRevision, values })
      }));
      message('Saved deployment options. Restart AgentConnect to apply them.');
      await load();
    }

    el('login').onclick = () => signIn().catch((error) => message(error.message, true));
    el('show-bootstrap').onclick = () => showBootstrap().catch((error) => message(error.message, true));
    el('bootstrap-provider').onchange = updateBootstrapProvider;
    el('bootstrap-github-owner').onchange = () => updateOwner('bootstrap-github');
    el('github-owner').onchange = () => updateOwner('github');
    el('bootstrap-logto-submit').onclick = () => bootstrapLogto().catch((error) => message(error.message, true));
    el('bootstrap-back').onclick = () => showBootstrapStep('logto');
    el('bootstrap-google-submit').onclick = () => bootstrapGoogle().catch((error) => message(error.message, true));
    el('bootstrap-github-submit').onclick = () => bootstrapGithub().catch((error) => message(error.message, true));
    el('bootstrap-slack-submit').onclick = () => bootstrapSlack().catch((error) => message(error.message, true));
    el('create-github').onclick = () => startGithub('github').catch((error) => message(error.message, true));
    el('save-logto-configuration').onclick = () => saveLogtoConfiguration().catch((error) => message(error.message, true));
    el('cancel-logto-configuration').onclick = cancelConfigurationEdit;
    el('save-github-configuration').onclick = () => saveGithubConfiguration().catch((error) => message(error.message, true));
    el('cancel-github-configuration').onclick = cancelConfigurationEdit;
    el('clear-github').onclick = () => clearProvider('github').catch((error) => message(error.message, true));
    el('connect-github-login').onclick = () => connectGithubLogin().catch((error) => message(error.message, true));
    el('check-github').onclick = () => checkGithub().catch((error) => message(error.message, true));
    el('create-slack').onclick = () => createSlack('slack').catch((error) => message(error.message, true));
    el('connect-slack-login').onclick = () => connectSlackLogin().catch((error) => message(error.message, true));
    el('save-slack-configuration').onclick = () => saveSlackConfiguration().catch((error) => message(error.message, true));
    el('cancel-slack-configuration').onclick = cancelConfigurationEdit;
    el('clear-slack').onclick = () => clearProvider('slack').catch((error) => message(error.message, true));
    el('check-slack').onclick = () => checkSlack().catch((error) => message(error.message, true));
    el('save-gitlab').onclick = () => saveGitlab().catch((error) => message(error.message, true));
    el('cancel-gitlab-configuration').onclick = cancelConfigurationEdit;
    el('clear-gitlab').onclick = () => clearProvider('gitlab').catch((error) => message(error.message, true));
    el('save-google').onclick = () => saveGoogle().catch((error) => message(error.message, true));
    el('cancel-google-configuration').onclick = cancelConfigurationEdit;
    el('clear-google').onclick = () => clearProvider('google').catch((error) => message(error.message, true));
    el('check-google').onclick = () => checkGoogle().catch((error) => message(error.message, true));
    el('create-feishu-login-app').onclick = () => createRegionalLoginApp('feishu').catch((error) => message(error.message, true));
    el('save-feishu-login-app').onclick = () => saveRegionalLoginApp('feishu').catch((error) => message(error.message, true));
    el('cancel-feishu-configuration').onclick = cancelConfigurationEdit;
    el('clear-feishu').onclick = () => clearProvider('feishu').catch((error) => message(error.message, true));
    el('check-feishu-login-app').onclick = () => checkRegionalLoginApp('feishu').catch((error) => message(error.message, true));
    el('create-lark-login-app').onclick = () => createRegionalLoginApp('lark').catch((error) => message(error.message, true));
    el('save-lark-login-app').onclick = () => saveRegionalLoginApp('lark').catch((error) => message(error.message, true));
    el('cancel-lark-configuration').onclick = cancelConfigurationEdit;
    el('clear-lark').onclick = () => clearProvider('lark').catch((error) => message(error.message, true));
    el('check-lark-login-app').onclick = () => checkRegionalLoginApp('lark').catch((error) => message(error.message, true));
    el('check-logto').onclick = () => checkLogto().catch((error) => message(error.message, true));
    el('reconcile-logto').onclick = () => reconcileLogto().then(load).catch((error) => message(error.message, true));
    el('logout').onclick = () => { sessionStorage.removeItem(tokenKey); load().catch((error) => message(error.message, true)); };
    el('save-options').onclick = () => saveOptions().catch((error) => message(error.message, true));
    for (const button of document.querySelectorAll('.edit-secret')) button.onclick = () => editSecret(button);
    for (const button of document.querySelectorAll('.edit-configuration')) button.onclick = () => beginConfigurationEdit(button.dataset.provider);
    updateBootstrapProvider();
    finishSignIn().then(load).catch((error) => message(error.message, true));
  </script>
</body>
</html>`
