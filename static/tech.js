import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

let techHistory = [];

const techChatWindow = document.getElementById('tech-chat-window');
const techChatForm = document.getElementById('tech-chat-form');
const techChatInput = document.getElementById('tech-chat-input');

function addTechMessage(text, role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  techChatWindow.appendChild(div);
  techChatWindow.scrollTop = techChatWindow.scrollHeight;
}

function typeTechMessage(fullText, provider, speedMs = 18) {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  techChatWindow.appendChild(div);
  techChatWindow.scrollTop = techChatWindow.scrollHeight;

  const words = fullText.split(' ');
  let i = 0;

  return new Promise((resolve) => {
    div.appendChild(cursor);
    function step() {
      if (i < words.length) {
        const chunk = (i === 0 ? '' : ' ') + words[i];
        cursor.insertAdjacentText('beforebegin', chunk);
        i++;
        techChatWindow.scrollTop = techChatWindow.scrollHeight;
        setTimeout(step, speedMs);
      } else {
        cursor.remove();
        if (provider) {
          const badge = document.createElement('div');
          badge.className = 'provider-badge';
          badge.textContent = provider;
          div.appendChild(badge);
        }
        resolve(div);
      }
    }
    step();
  });
}

// Shows a small shimmering status line while waiting on the AI, cycling
// through a few phrases instead of sitting on one static word. Mirrors the
// same pattern used on the main chat (see script.js: showStatusIndicator).
const TECH_STATUS_PHRASES = [
  'Checking today\'s prices...',
  'Comparing specs...',
  'Scanning the latest listings...',
  'Crunching the numbers...',
];

function showTechStatusIndicator() {
  const div = document.createElement('div');
  div.className = 'msg assistant status-msg';
  const textSpan = document.createElement('span');
  textSpan.className = 'status-text';
  textSpan.textContent = TECH_STATUS_PHRASES[0];
  div.appendChild(textSpan);
  techChatWindow.appendChild(div);
  techChatWindow.scrollTop = techChatWindow.scrollHeight;

  let i = 0;
  let stopped = false;
  const timer = setInterval(() => {
    textSpan.classList.add('status-fade');
    setTimeout(() => {
      if (stopped) return;
      i = (i + 1) % TECH_STATUS_PHRASES.length;
      textSpan.textContent = TECH_STATUS_PHRASES[i];
      textSpan.classList.remove('status-fade');
      techChatWindow.scrollTop = techChatWindow.scrollHeight;
    }, 200);
  }, 2000);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      div.remove();
    },
  };
}

// Renders a Tech Desk product comparison as an actual HTML table instead
// of prose — see parse_comparison_table_reply in app.py for the JSON shape
// this expects.
function renderComparisonTable(comparison) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant comparison-card';

  const specLabels = [];
  comparison.products.forEach((p) => {
    Object.keys(p.specs || {}).forEach((label) => {
      if (!specLabels.includes(label)) specLabels.push(label);
    });
  });

  const table = document.createElement('table');
  table.className = 'comparison-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  comparison.products.forEach((p) => {
    const th = document.createElement('th');
    th.textContent = p.name || '';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  const priceRow = document.createElement('tr');
  const priceLabelCell = document.createElement('td');
  priceLabelCell.textContent = 'Price';
  priceRow.appendChild(priceLabelCell);
  comparison.products.forEach((p) => {
    const td = document.createElement('td');
    td.className = 'comparison-price';
    td.textContent = p.price || '—';
    priceRow.appendChild(td);
  });
  tbody.appendChild(priceRow);

  specLabels.forEach((label) => {
    const row = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    row.appendChild(labelCell);
    comparison.products.forEach((p) => {
      const td = document.createElement('td');
      td.textContent = (p.specs && p.specs[label]) || '—';
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);

  if (comparison.verdict) {
    const verdict = document.createElement('div');
    verdict.className = 'comparison-verdict';
    verdict.textContent = comparison.verdict;
    wrap.appendChild(verdict);
  }

  techChatWindow.appendChild(wrap);
  techChatWindow.scrollTop = techChatWindow.scrollHeight;
}

async function sendTechMessage(message) {
  if (!message) return;
  techChatInput.disabled = true;
  addTechMessage(message, 'user');

  const statusHandle = showTechStatusIndicator();

  try {
    const res = await fetch('/api/tech_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: techHistory })
    });
    const data = await res.json();
    statusHandle.stop();
    if (data.reply) {
      techHistory.push({ role: 'user', parts: [{ text: message }] });
      techHistory.push({ role: 'model', parts: [{ text: data.reply }] });
      await typeTechMessage(data.reply, data.provider);
      if (data.comparison) {
        renderComparisonTable(data.comparison);
      }
    } else {
      addTechMessage(data.error || 'Something went wrong.', 'system');
    }
  } catch (err) {
    statusHandle.stop();
    addTechMessage('Connection error. Is the server running?', 'system');
  } finally {
    techChatInput.disabled = false;
    techChatInput.focus();
  }
}

techChatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = techChatInput.value.trim();
  techChatInput.value = '';
  sendTechMessage(message);
});

// Quick-prompt chips
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-prompt');
    sendTechMessage(prompt);
  });
});

// ==========================================
// Punch AI - Scroll-to-bottom button
// ==========================================
// Shown only once the user has scrolled up away from the latest message,
// so it doesn't sit on screen the rest of the time.
const techScrollBottomBtn = document.getElementById('tech-scroll-bottom-btn');
if (techScrollBottomBtn) {
  const NEAR_BOTTOM_PX = 80;
  const isNearBottom = () =>
    techChatWindow.scrollHeight - techChatWindow.scrollTop - techChatWindow.clientHeight < NEAR_BOTTOM_PX;

  techChatWindow.addEventListener('scroll', () => {
    techScrollBottomBtn.classList.toggle('hidden', isNearBottom());
  });

  techScrollBottomBtn.addEventListener('click', () => {
    techChatWindow.scrollTo({ top: techChatWindow.scrollHeight, behavior: 'smooth' });
  });
}

// ==========================================
// Punch AI - Price watchlist (Punch Pro feature)
// ==========================================
const watchlistToggle = document.getElementById('watchlist-toggle');
const watchlistBody = document.getElementById('watchlist-body');
const watchlistLockedNote = document.getElementById('watchlist-locked-note');
const watchlistUnlocked = document.getElementById('watchlist-unlocked');
const watchlistAddForm = document.getElementById('watchlist-add-form');
const watchlistProductInput = document.getElementById('watchlist-product-input');
const watchlistPriceInput = document.getElementById('watchlist-price-input');
const watchlistItemsEl = document.getElementById('watchlist-items');

let techCurrentUser = null;
let isProUser = false;
let watchlistOpen = false;
let watchlistLoadedOnce = false;

if (watchlistToggle) {
  watchlistToggle.addEventListener('click', () => {
    watchlistOpen = !watchlistOpen;
    watchlistBody.classList.toggle('hidden', !watchlistOpen);
    watchlistToggle.textContent = watchlistOpen ? 'Hide' : 'Show';
    if (watchlistOpen && isProUser && !watchlistLoadedOnce) {
      watchlistLoadedOnce = true;
      loadWatchlist();
    }
  });
}

async function getTechIdToken() {
  if (!techCurrentUser) return null;
  try {
    return await techCurrentUser.getIdToken();
  } catch (err) {
    console.error('Failed to get auth token:', err);
    return null;
  }
}

function renderWatchlistItems(items) {
  watchlistItemsEl.innerHTML = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'watchlist-empty';
    empty.textContent = "You're not watching any prices yet.";
    watchlistItemsEl.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'watchlist-item';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'watchlist-item-name';
    name.textContent = item.productName;
    const meta = document.createElement('div');
    meta.className = 'watchlist-item-meta';
    const lastChecked = typeof item.lastCheckedPrice === 'number' ? `₹${item.lastCheckedPrice.toLocaleString('en-IN')}` : 'not checked yet';
    meta.textContent = `Target: ₹${Number(item.targetPrice).toLocaleString('en-IN')} · Last seen: ${lastChecked}`;
    info.appendChild(name);
    info.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'watchlist-item-remove';
    removeBtn.setAttribute('aria-label', 'Stop watching this price');
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', async () => {
      const token = await getTechIdToken();
      if (!token) return;
      try {
        await fetch('/api/watchlist/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: item.id }),
        });
        loadWatchlist();
      } catch (err) {
        console.error('Failed to remove watch item:', err);
      }
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    watchlistItemsEl.appendChild(row);
  });
}

async function loadWatchlist() {
  const token = await getTechIdToken();
  if (!token) return;
  try {
    const res = await fetch('/api/watchlist/list', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    renderWatchlistItems(data.items || []);
  } catch (err) {
    console.error('Failed to load watchlist:', err);
  }
}

if (watchlistAddForm) {
  watchlistAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const productName = watchlistProductInput.value.trim();
    const targetPrice = parseFloat(watchlistPriceInput.value);
    if (!productName || !targetPrice) return;

    const token = await getTechIdToken();
    if (!token) return;

    try {
      const res = await fetch('/api/watchlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productName, targetPrice }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Could not add that to your watchlist.');
        return;
      }
      watchlistProductInput.value = '';
      watchlistPriceInput.value = '';
      loadWatchlist();
    } catch (err) {
      console.error('Failed to add watch item:', err);
    }
  });
}

// Shows the locked/unlocked state of the watchlist panel based on the
// signed-in user's real plan (read from their Firestore profile doc —
// the same authoritative source the backend checks, so the UI here is
// just a convenience, not the actual enforcement).
onAuthStateChanged(auth, async (user) => {
  techCurrentUser = user;
  isProUser = false;
  watchlistLoadedOnce = false;

  if (!user) {
    watchlistLockedNote.classList.remove('hidden');
    watchlistUnlocked.classList.add('hidden');
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    isProUser = snap.exists() && snap.data().plan === 'pro';
  } catch (err) {
    console.error('Failed to check plan:', err);
  }

  if (isProUser) {
    watchlistLockedNote.classList.add('hidden');
    watchlistUnlocked.classList.remove('hidden');
    if (watchlistOpen && !watchlistLoadedOnce) {
      watchlistLoadedOnce = true;
      loadWatchlist();
    }
  } else {
    watchlistLockedNote.classList.remove('hidden');
    watchlistUnlocked.classList.add('hidden');
  }
});