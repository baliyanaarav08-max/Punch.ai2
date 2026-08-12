let techHistory = [];

const techChatWindow = document.getElementById('tech-chat-window');
const techChatForm = document.getElementById('tech-chat-form');
const techChatInput = document.getElementById('tech-chat-input');

// ==========================================
// Punch AI - Model picker (Tech Desk)
// ==========================================
const techModelSelectWrap = document.getElementById('tech-model-select-wrap');
const techModelSelectBtn = document.getElementById('tech-model-select-btn');
const techModelSelectLabel = document.getElementById('tech-model-select-label');
const techModelSelectMenu = document.getElementById('tech-model-select-menu');

const TECH_MODEL_LABELS = { lite: 'Punch Lite', pro: 'Punch Pro', max: 'Punch Max' };
let techSelectedModelTier = 'max';

if (techModelSelectBtn) {
  techModelSelectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    techModelSelectWrap.classList.toggle('open');
    techModelSelectMenu.classList.toggle('hidden');
  });

  techModelSelectMenu.querySelectorAll('.model-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      techSelectedModelTier = opt.dataset.model;
      techModelSelectLabel.textContent = TECH_MODEL_LABELS[techSelectedModelTier] || 'Punch Max';
      techModelSelectMenu.querySelectorAll('.model-option').forEach((o) => o.classList.toggle('selected', o === opt));
      techModelSelectWrap.classList.remove('open');
      techModelSelectMenu.classList.add('hidden');
    });
  });

  document.addEventListener('click', (e) => {
    if (!techModelSelectWrap.contains(e.target)) {
      techModelSelectWrap.classList.remove('open');
      techModelSelectMenu.classList.add('hidden');
    }
  });
}

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

async function sendTechMessage(message) {
  if (!message) return;
  techChatInput.disabled = true;
  addTechMessage(message, 'user');

  const statusHandle = showTechStatusIndicator();

  try {
    const res = await fetch('/api/tech_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: techHistory, model: techSelectedModelTier })
    });
    const data = await res.json();
    statusHandle.stop();
    if (data.reply) {
      techHistory.push({ role: 'user', parts: [{ text: message }] });
      techHistory.push({ role: 'model', parts: [{ text: data.reply }] });
      await typeTechMessage(data.reply, data.provider);
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