// Small shared helpers for the studio pages.

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
export function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'bad' ? 5200 : 2600);
}

export function modal({ title, body, confirm = 'OK', cancel = 'Cancel', onConfirm, wide = false }) {
  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal__card" ${wide ? 'style="width:min(760px,100%)"' : ''}>
      <h2>${title}</h2>
      ${body}
      <div class="modal__foot">
        <button class="btn" data-cancel>${cancel}</button>
        <button class="btn btn--primary" data-ok>${confirm}</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const close = () => root.remove();
  root.querySelector('[data-cancel]').onclick = close;
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  root.querySelector('[data-ok]').onclick = async () => {
    try {
      await onConfirm?.(root, close);
      if (document.body.contains(root)) close();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') root.querySelector('[data-ok]').click();
  });
  setTimeout(() => root.querySelector('input,textarea')?.focus(), 30);
  return { root, close };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const debounce = (fn, ms = 400) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
