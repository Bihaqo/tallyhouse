'use strict';

const err = document.getElementById('err');
const devForm = document.getElementById('dev-form');
const googleBtn = document.getElementById('google-signin');
const capacityNote = document.getElementById('capacity-note');
const signinNote = document.getElementById('signin-note');
const closedNotice = document.getElementById('closed-notice');
const closedText = document.getElementById('closed-text');
const waitlistJoin = document.getElementById('waitlist-join');
const waitlistStatus = document.getElementById('waitlist-status');

const PAUSED_NOTE = 'New registrations are paused for now. If you already have an account, you can still sign in.';

// Surface an error passed back by the OAuth callback (?error=...).
const params = new URLSearchParams(location.search);
if (params.get('error')) {
  err.textContent = params.get('error');
  history.replaceState(null, '', location.pathname);
}

// ?closed=1 means the sign-in worked but the cap refused a new account. The
// server is holding the verified address, so all that is left is the offer.
const turnedAway = params.get('closed') === '1';
if (turnedAway) {
  closedText.textContent =
    'Registration is currently stopped — this dashboard is capped while it settles. '
    + 'You can join the waiting list and we will get in touch when a place opens up.';
  closedNotice.hidden = false;
  history.replaceState(null, '', location.pathname);
}

// Show whichever sign-in methods the server has configured.
fetch('/api/auth-config')
  .then((res) => res.json())
  .then((cfg) => {
    if (cfg.google) googleBtn.hidden = false;
    if (cfg.dev) devForm.hidden = false;
    if (!cfg.google && !cfg.dev) err.textContent = 'No sign-in method is configured.';
    // Say so up front, so nobody signs in only to be turned away — unless they
    // already have been, in which case the notice below is saying more than this.
    const full = cfg.atCapacity || turnedAway;
    if (cfg.atCapacity && !turnedAway) {
      capacityNote.textContent = PAUSED_NOTE;
      capacityNote.hidden = false;
    }
    // "This creates your account" is the wrong promise to make while new
    // accounts are being refused; the capacity note above says the true thing.
    signinNote.hidden = !cfg.google || full;
  })
  .catch(() => {
    devForm.hidden = false; // fall back to the dev form if the probe fails
  });

waitlistJoin.addEventListener('click', async () => {
  waitlistJoin.disabled = true;
  waitlistStatus.textContent = '';
  try {
    const res = await fetch('/api/waitlist', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      waitlistStatus.textContent = `Thanks — ${body.email} is on the list.`;
      waitlistJoin.hidden = true;
      return;
    }
    waitlistStatus.textContent = body.error || 'Could not add you to the list';
    waitlistJoin.disabled = false;
  } catch {
    waitlistStatus.textContent = 'Network error';
    waitlistJoin.disabled = false;
  }
});

// Dev login: create/find the account by email, then go where the server says.
devForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = devForm.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value.trim() }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      location.href = body.onboarding ? '/onboarding' : '/';
      return;
    }
    err.textContent = body.error || 'Login failed';
  } catch {
    err.textContent = 'Network error';
  } finally {
    btn.disabled = false;
  }
});
