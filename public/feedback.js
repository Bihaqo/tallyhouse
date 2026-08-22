'use strict';

// The feedback form, and the optional picture of the page that goes with it.
//
// The picture is taken when the dialog opens, before it is on screen — a
// capture made after would be a picture of the feedback form covering the thing
// being reported. It is held in this tab and nowhere else until Send is pressed
// with the box ticked; leaving the box alone, or closing the dialog, sends
// nothing and keeps nothing.
//
// Rendering happens here rather than on the server for the obvious reason and a
// less obvious one: the server has never seen this page, and asking it to draw
// one would mean giving it a browser and this account's data. The DOM the user
// is looking at is the only place the picture can honestly come from.

(() => {
  const $ = (id) => document.getElementById(id);
  const modal = $('feedback-modal');
  if (!modal) return;

  const message = $('feedback-message');
  const attach = $('feedback-screenshot');
  const preview = $('feedback-preview');
  const previewImg = $('feedback-preview-img');
  const captureNote = $('feedback-capture-note');
  const status = $('feedback-status');
  const sendBtn = $('feedback-send');

  // The captured PNG as a data: URL, for this dialog only.
  let shot = null;
  let capturing = null;

  const kb = (dataUrl) => Math.round((dataUrl.length * 3) / 4 / 1024);

  /**
   * Draw the page as it is right now.
   *
   * `.wrap` rather than document.body so the dialog is outside what is drawn
   * even when a later change opens it sooner. Failure is not an error worth
   * shouting about: the message is the point, and the checkbox simply reports
   * that there is nothing to attach.
   */
  async function capture() {
    const target = document.querySelector('.wrap') || document.body;
    try {
      const dataUrl = await window.modernScreenshot.domToPng(target, {
        // The page's own background, or transparent PNGs of dark text on
        // nothing come out unreadable.
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
        scale: 1,
        // Fonts are the system stack here, so there is nothing to embed and
        // fetching would only make this slower.
        font: false,
      });
      return dataUrl;
    } catch (err) {
      console.warn('Could not draw the page:', err && err.message);
      return null;
    }
  }

  function showPreview() {
    if (!attach.checked) {
      preview.hidden = true;
      return;
    }
    if (shot) {
      previewImg.src = shot;
      preview.hidden = false;
      captureNote.hidden = false;
      captureNote.textContent = `This is exactly what will be sent (about ${kb(shot)} KB).`;
      return;
    }
    preview.hidden = true;
    captureNote.hidden = false;
    captureNote.textContent = capturing
      ? 'Drawing the page…'
      : 'The page could not be drawn in this browser — your message will be sent on its own.';
  }

  function open() {
    message.value = '';
    attach.checked = false;
    status.textContent = '';
    preview.hidden = true;
    captureNote.hidden = true;
    previewImg.removeAttribute('src');
    shot = null;
    sendBtn.disabled = false;

    // Started before the dialog is shown, so the dialog is not in it.
    capturing = capture().then((dataUrl) => {
      shot = dataUrl;
      capturing = null;
      showPreview();
    });

    modal.showModal();
    message.focus();
  }

  function close() {
    // Nothing captured outlives the dialog: an unsent picture of somebody's
    // balances should not sit in this tab until the page is reloaded.
    shot = null;
    previewImg.removeAttribute('src');
    modal.close();
  }

  async function send() {
    const text = message.value.trim();
    if (!text) {
      status.textContent = 'Write a message first.';
      message.focus();
      return;
    }
    if (attach.checked && capturing) {
      status.textContent = 'Still drawing the page — one moment.';
      await capturing;
    }
    sendBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          page: location.pathname + location.hash,
          // Ticked *and* actually captured. An unticked box sends no key at all.
          ...(attach.checked && shot ? { screenshot: shot } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = 'Sent — thank you.';
        setTimeout(close, 900);
        return;
      }
      status.textContent = body.error || 'Could not send your message';
      sendBtn.disabled = false;
    } catch {
      status.textContent = 'Network error';
      sendBtn.disabled = false;
    }
  }

  $('feedback-btn').addEventListener('click', open);
  $('feedback-cancel').addEventListener('click', close);
  attach.addEventListener('change', showPreview);
  sendBtn.addEventListener('click', send);
  // Esc closes a <dialog> on its own; this makes that path clear the picture too.
  modal.addEventListener('close', () => {
    shot = null;
    previewImg.removeAttribute('src');
  });
})();
