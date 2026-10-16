const msg = document.getElementById('login-msg');

async function finishSignIn(path, body) {
  msg.textContent = '';
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Sign-in failed');
    location.replace('/');
  } catch (e) {
    msg.textContent = e.message;
  }
}

// Called by Google's button with an ID token, which the server verifies.
window.onGoogleCredential = (resp) => finishSignIn('/api/auth/google', { credential: resp.credential });

function whenGoogleReady(cb, tries = 0) {
  if (window.google?.accounts?.id) return cb();
  if (tries > 100) { msg.textContent = 'Could not load Google sign-in. Check your internet connection and refresh.'; return; }
  setTimeout(() => whenGoogleReady(cb, tries + 1), 100);
}

(async () => {
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({}));
  if (cfg.devLogin) {
    document.getElementById('dev-login').hidden = false;
    document.getElementById('dev-form').onsubmit = (e) => {
      e.preventDefault();
      finishSignIn('/api/auth/dev', { email: document.getElementById('dev-email').value });
    };
  }
  if (!cfg.googleClientId) {
    msg.textContent = 'Google sign-in is not set up yet: add GOOGLE_CLIENT_ID to the .env file and restart the server.';
    return;
  }
  whenGoogleReady(() => {
    google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: window.onGoogleCredential, ux_mode: 'popup' });
    google.accounts.id.renderButton(document.getElementById('g-btn'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 280 });
  });
})();
