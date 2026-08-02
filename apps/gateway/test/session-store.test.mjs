import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SessionStore } from '../src/session-store.mjs';

const options = { sessionTtlMs: 60_000, ticketTtlMs: 30_000 };

test('creates and updates activation sessions', () => {
  const store = new SessionStore(options);
  const created = store.createSession({ deviceId: 'web-device-1', clientId: crypto.randomUUID() });
  assert.equal(created.status, 'pending');

  const updated = store.updateSession(created.id, { status: 'activated' });
  assert.equal(updated.status, 'activated');
  assert.equal(store.getSession(created.id).deviceId, 'web-device-1');
});

test('issues single-use tickets only for activated sessions', () => {
  const store = new SessionStore(options);
  const created = store.createSession({ deviceId: 'web-device-2', clientId: crypto.randomUUID() });
  assert.equal(store.issueTicket(created.id), null);

  store.updateSession(created.id, { status: 'activated' });
  const ticket = store.issueTicket(created.id);
  assert.ok(ticket.token);
  assert.ok(store.consumeTicket(ticket.token));
  assert.equal(store.consumeTicket(ticket.token), null);
});
