// Telegram notification channel via the Bot API (zero dependencies).
// Failures are logged by the caller; sendTelegram only reports success.
export async function sendTelegram({ botToken, chatId, text, fetchImpl = fetch } = {}) {
  if (!botToken || !chatId) return false;
  if (typeof botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text }),
      redirect: 'manual',
      signal: controller.signal,
    });
    res.body?.cancel?.().catch(() => {});
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
