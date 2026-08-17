// Runs in the isolated world. Its only job is to relay messages between the
// injected provider (page context) and the service worker.

const TO_BRIDGE = 'miniwallet:to-bridge';
const TO_PAGE = 'miniwallet:to-page';

function replyToPage(payload) {
  window.postMessage({ target: TO_PAGE, payload }, window.location.origin);
}

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.target !== TO_BRIDGE) return;

  const { id, method, params } = message.payload ?? {};

  try {
    const response = await chrome.runtime.sendMessage({ type: 'RPC_REQUEST', method, params });
    if (response?.error) replyToPage({ id, error: response.error });
    else replyToPage({ id, result: response?.result });
  } catch (err) {
    // Usually means the extension was reloaded mid-session.
    replyToPage({
      id,
      error: { code: 4900, message: 'MiniWallet is unavailable. Reload the page and try again.' },
    });
  }
});

// Wallet-initiated events: account switch, network switch, disconnect.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'WALLET_EVENT') {
    replyToPage({ event: message.event, params: message.params });
  }
});
