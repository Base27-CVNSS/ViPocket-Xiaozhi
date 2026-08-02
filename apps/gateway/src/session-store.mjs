import crypto from 'node:crypto';

function now() {
  return Date.now();
}

export class SessionStore {
  constructor({ sessionTtlMs, ticketTtlMs }) {
    this.sessionTtlMs = sessionTtlMs;
    this.ticketTtlMs = ticketTtlMs;
    this.sessions = new Map();
    this.tickets = new Map();
  }

  createSession(data) {
    this.cleanup();
    const id = crypto.randomUUID();
    const session = {
      id,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: now() + this.sessionTtlMs,
      status: 'pending',
      ...data
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  updateSession(id, patch) {
    const current = this.getSession(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      updatedAt: now(),
      expiresAt: now() + this.sessionTtlMs
    };
    this.sessions.set(id, next);
    return next;
  }

  deleteSession(id) {
    return this.sessions.delete(id);
  }

  issueTicket(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'activated') return null;
    const token = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(token, {
      token,
      sessionId,
      expiresAt: now() + this.ticketTtlMs,
      used: false
    });
    return { token, expiresAt: now() + this.ticketTtlMs };
  }

  consumeTicket(token) {
    this.cleanup();
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.used || ticket.expiresAt <= now()) return null;
    ticket.used = true;
    this.tickets.delete(token);
    return this.getSession(ticket.sessionId);
  }

  cleanup() {
    const time = now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= time) this.sessions.delete(id);
    }
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= time || ticket.used) this.tickets.delete(token);
    }
  }
}
