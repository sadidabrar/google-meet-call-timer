let startTime = Date.now();
let timerElement = null;

function createTimerDisplay() {
  if (document.getElementById('gmeet-call-timer')) return;
  timerElement = document.createElement('div');
  timerElement.id = 'gmeet-call-timer';
  timerElement.className = 'gmeet-timer-badge';
  timerElement.textContent = '00:00:00';
  document.body.appendChild(timerElement);
}

function updateTimer() {
  if (!timerElement) createTimerDisplay();
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');
  if (timerElement) {
    timerElement.textContent = `${hrs}:${mins}:${secs}`;
  }
}

createTimerDisplay();
setInterval(updateTimer, 1000);
