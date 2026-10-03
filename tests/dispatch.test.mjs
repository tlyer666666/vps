import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from '../server/notify.js';

test('dispatch fans out to webhook and telegram in parallel', async () => {
  const calls = [];
  const dispatch = createDispatch({
    store: { getSetting: () => ({ webhookUrl: 'https://hook', telegram_bot_token: 't', telegram_chat_id: '42' }) },
    notifier: async (event) => { calls.push(['webhook', event.type]); return true; },
    sendTelegram: async ({ text }) => { calls.push(['telegram', text]); return true; },
  });
  const ok = await dispatch({ type: 'cpu', message: 'CPU 99%' }, { name: 'web-1' });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['telegram', 'webhook']);
  assert.equal(calls.find((c) => c[0] === 'telegram')[1], '[VPSWatch] CPU 99%');
});

test('dispatch with no channels configured returns false and calls nothing', async () => {
  let called = 0;
  const dispatch = createDispatch({
    store: { getSetting: () => ({}) },
    notifier: async () => { called += 1; return true; },
    sendTelegram: async () => { called += 1; return true; },
  });
  assert.equal(await dispatch({ type: 'cpu', message: 'x' }, { name: 'a' }), false);
  assert.equal(called, 0);
});

test('dispatch never throws even when settings storage fails (stability)', async () => {
  const dispatch = createDispatch({
    store: { getSetting: () => { throw new Error('disk on fire'); } },
    notifier: async () => true,
    sendTelegram: async () => true,
  });
  const ok = await dispatch({ type: 'cpu', message: 'x' }, { name: 'a' });
  assert.equal(ok, false, 'settings read failure must degrade, not crash the process');
});

test('dispatch swallows channel rejections; a dead channel does not poison the next dispatch', async () => {
  let calls = 0;
  const dispatch = createDispatch({
    store: { getSetting: () => ({ webhookUrl: 'https://hook' }) },
    notifier: async () => { calls += 1; if (calls === 1) throw new Error('disk on fire'); return true; },
    sendTelegram: async () => { throw new Error('never configured anyway'); },
  });
  assert.equal(await dispatch({ type: 'cpu', message: 'x' }, { name: 'a' }), false, 'rejected channel reports false');
  assert.equal(await dispatch({ type: 'cpu', message: 'x' }, { name: 'a' }), true, 'transient failure does not poison later dispatches');
});
