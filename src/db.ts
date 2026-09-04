import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config';

export type SessionStatus =
    | 'pending'
    | 'qr'
    | 'connected'
    | 'disconnected'
    | 'logged_out';

export type SessionRow = {
    id: string;
    user_id: string;
    status: SessionStatus;
    phone_number: string | null;
    last_error: string | null;
    auto_start: number;
    created_at: string;
    updated_at: string;
};

export type ConversationRow = {
    session_id: string;
    jid: string;
    step: string;
    data: string;
    updated_at: string;
    expires_at: string;
};

const path = resolve(config.DATABASE_PATH);

mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        phone_number TEXT,
        last_error   TEXT,
        auto_start   INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_creds (
        session_id TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_keys (
        session_id TEXT NOT NULL,
        type       TEXT NOT NULL,
        key_id     TEXT NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (session_id, type, key_id),
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
        session_id TEXT NOT NULL,
        jid        TEXT NOT NULL,
        step       TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (session_id, jid),
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS conversations_expires_at_index
        ON conversations (expires_at);
`);

const statements = {
    findSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    allSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at ASC'),
    startableSessions: db.prepare(
        "SELECT * FROM sessions WHERE auto_start = 1 AND status != 'logged_out' ORDER BY created_at ASC",
    ),
    upsertSession: db.prepare(`
        INSERT INTO sessions (id, user_id, status, updated_at)
        VALUES (?, ?, 'pending', datetime('now'))
        ON CONFLICT (id) DO UPDATE SET
            user_id = excluded.user_id,
            auto_start = 1,
            updated_at = datetime('now')
    `),
    updateSessionStatus: db.prepare(`
        UPDATE sessions
        SET status = ?, phone_number = ?, last_error = ?, updated_at = datetime('now')
        WHERE id = ?
    `),
    updateAutoStart: db.prepare(
        "UPDATE sessions SET auto_start = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),

    getCreds: db.prepare('SELECT data FROM auth_creds WHERE session_id = ?'),
    saveCreds: db.prepare(`
        INSERT INTO auth_creds (session_id, data) VALUES (?, ?)
        ON CONFLICT (session_id) DO UPDATE SET data = excluded.data
    `),
    getAuthKey: db.prepare(
        'SELECT data FROM auth_keys WHERE session_id = ? AND type = ? AND key_id = ?',
    ),
    setAuthKey: db.prepare(`
        INSERT INTO auth_keys (session_id, type, key_id, data) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id, type, key_id) DO UPDATE SET data = excluded.data
    `),
    deleteAuthKey: db.prepare(
        'DELETE FROM auth_keys WHERE session_id = ? AND type = ? AND key_id = ?',
    ),
    clearCreds: db.prepare('DELETE FROM auth_creds WHERE session_id = ?'),
    clearAuthKeys: db.prepare('DELETE FROM auth_keys WHERE session_id = ?'),

    getConversation: db.prepare(
        'SELECT * FROM conversations WHERE session_id = ? AND jid = ?',
    ),
    saveConversation: db.prepare(`
        INSERT INTO conversations (session_id, jid, step, data, updated_at, expires_at)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT (session_id, jid) DO UPDATE SET
            step = excluded.step,
            data = excluded.data,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
    `),
    deleteConversation: db.prepare(
        'DELETE FROM conversations WHERE session_id = ? AND jid = ?',
    ),
    purgeConversations: db.prepare(
        "DELETE FROM conversations WHERE expires_at < datetime('now')",
    ),
};

export const sessionsRepo = {
    find(id: string): SessionRow | null {
        return (statements.findSession.get(id) as SessionRow | undefined) ?? null;
    },
    all(): SessionRow[] {
        return statements.allSessions.all() as unknown as SessionRow[];
    },
    startable(): SessionRow[] {
        return statements.startableSessions.all() as unknown as SessionRow[];
    },
    upsert(id: string, userId: string): void {
        statements.upsertSession.run(id, userId);
    },
    updateStatus(
        id: string,
        status: SessionStatus,
        phoneNumber: string | null = null,
        lastError: string | null = null,
    ): void {
        statements.updateSessionStatus.run(status, phoneNumber, lastError, id);
    },
    setAutoStart(id: string, autoStart: boolean): void {
        statements.updateAutoStart.run(autoStart ? 1 : 0, id);
    },
    delete(id: string): void {
        statements.deleteSession.run(id);
    },
};

export const authRepo = {
    getCreds(sessionId: string): string | null {
        const row = statements.getCreds.get(sessionId) as
            | { data: string }
            | undefined;

        return row?.data ?? null;
    },
    saveCreds(sessionId: string, data: string): void {
        statements.saveCreds.run(sessionId, data);
    },
    getKey(sessionId: string, type: string, keyId: string): string | null {
        const row = statements.getAuthKey.get(sessionId, type, keyId) as
            | { data: string }
            | undefined;

        return row?.data ?? null;
    },
    setKey(sessionId: string, type: string, keyId: string, data: string): void {
        statements.setAuthKey.run(sessionId, type, keyId, data);
    },
    deleteKey(sessionId: string, type: string, keyId: string): void {
        statements.deleteAuthKey.run(sessionId, type, keyId);
    },
    clear(sessionId: string): void {
        statements.clearCreds.run(sessionId);
        statements.clearAuthKeys.run(sessionId);
    },
};

export const conversationsRepo = {
    find(sessionId: string, jid: string): ConversationRow | null {
        return (
            (statements.getConversation.get(sessionId, jid) as
                | ConversationRow
                | undefined) ?? null
        );
    },
    save(
        sessionId: string,
        jid: string,
        step: string,
        data: string,
        expiresAt: string,
    ): void {
        statements.saveConversation.run(sessionId, jid, step, data, expiresAt);
    },
    delete(sessionId: string, jid: string): void {
        statements.deleteConversation.run(sessionId, jid);
    },
    purgeExpired(): number {
        return Number(statements.purgeConversations.run().changes ?? 0);
    },
};

/** Agrupa várias escritas numa transação — o Baileys grava chaves em lote. */
export function transaction(fn: () => void): void {
    db.exec('BEGIN');

    try {
        fn();
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

export function closeDatabase(): void {
    db.close();
}
