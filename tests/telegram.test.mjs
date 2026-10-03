import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegram } from '../server/telegram.js';

const CH = { botToken: '123:abc', chatId: '42' };

test('posts sendMessage to the bot API with chat_id and text', async () => {
  let seen;
  const ok = await sendTelegram({
    ...CH,
    text: '[VPSWatch] 测试',
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return { ok: true };
    },
  });
  assert.equal(ok, true);
  assert.equal(seen.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(seen.body.chat_id, '42');
  assert.equal(seen.body.text, '[VPSWatch] 测试');
});

test('missing token or chat id short-circuits false without fetching', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return { ok: true }; };
  assert.equal(await sendTelegram({ botToken: '', chatId: '42', text: 'x', fetchImpl }), false);
  assert.equal(await sendTelegram({ ...CH, chatId: '', text: 'x', fetchImpl }), false);
  assert.equal(called, 0);
});

test('non-2xx, timeout and network errors return false without throwing', async () => {
  assert.equal(await sendTelegram({ ...CH, text: 'x', fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await sendTelegram({
    ...CH, text: 'x',
    fetchImpl: async (url, init) => { init.signal.dispatchEvent(new Event('abort')); throw new Error('aborted'); },
  }), false);
  assert.equal(await sendTelegram({ ...CH, text: 'x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});
