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

async function sendTechMessage(message) {
  if (!message) return;
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
      addTechMessage(data.reply, 'assistant');
    } else {
      addTechMessage(data.error || 'Something went wrong.', 'system');
    }
  } catch (err) {
    addTechMessage('Connection error. Is the server running?', 'system');
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
