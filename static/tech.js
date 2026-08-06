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

function typeTechMessage(fullText, speedMs = 18) {
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
        resolve(div);
      }
    }
    step();
  });
}

async function sendTechMessage(message) {
  if (!message) return;
  techChatInput.disabled = true;
  addTechMessage(message, 'user');

  try {
    const res = await fetch('/api/tech_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: techHistory })
    });
    const data = await res.json();
    if (data.reply) {
      techHistory.push({ role: 'user', parts: [{ text: message }] });
      techHistory.push({ role: 'model', parts: [{ text: data.reply }] });
      await typeTechMessage(data.reply);
    } else {
      addTechMessage(data.error || 'Something went wrong.', 'system');
    }
  } catch (err) {
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