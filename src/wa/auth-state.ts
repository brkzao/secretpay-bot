import {
    BufferJSON,
    initAuthCreds,
    proto,
    type AuthenticationCreds,
    type AuthenticationState,
    type SignalDataTypeMap,
} from 'baileys';

import { authRepo, transaction } from '../db';
import { logger } from '../logger';

export type PersistentAuthState = {
    state: AuthenticationState;
    saveCreds: () => void;
    clear: () => void;
};

/**
 * AuthState do Baileys persistido em SQLite.
 *
 * O `useMultiFileAuthState` oficial grava em disco local — inviável em
 * container efêmero, onde a sessão morreria a cada deploy. Aqui `creds` e as
 * chaves do Signal ficam no banco, chaveadas por sessão.
 */
export function useSqliteAuthState(sessionId: string): PersistentAuthState {
    const stored = authRepo.getCreds(sessionId);

    const creds: AuthenticationCreds = stored
        ? JSON.parse(stored, BufferJSON.reviver)
        : initAuthCreds();

    const log = logger.child({ scope: 'auth-state', sessionId });

    const saveCreds = (): void => {
        try {
            authRepo.saveCreds(
                sessionId,
                JSON.stringify(creds, BufferJSON.replacer),
            );
        } catch (error) {
            // Uma gravação perdida aqui degrada a sessão silenciosamente e só
            // aparece minutos depois, como erro de stream sem explicação.
            log.error(
                { err: (error as Error).message },
                'falha ao gravar as credenciais',
            );

            throw error;
        }
    };

    if (!stored) {
        saveCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async <T extends keyof SignalDataTypeMap>(
                    type: T,
                    ids: string[],
                ) => {
                    const result: {
                        [id: string]: SignalDataTypeMap[T];
                    } = {};

                    try {
                        for (const id of ids) {
                            const raw = authRepo.getKey(sessionId, type, id);

                            if (raw === null) {
                                continue;
                            }

                            let value = JSON.parse(raw, BufferJSON.reviver);

                            if (type === 'app-state-sync-key' && value) {
                                value =
                                    proto.Message.AppStateSyncKeyData.fromObject(
                                        value,
                                    );
                            }

                            result[id] = value;
                        }
                    } catch (error) {
                        log.error(
                            {
                                type,
                                ids: ids.length,
                                err: (error as Error).message,
                            },
                            'falha ao ler chaves do Signal',
                        );

                        throw error;
                    }

                    return result;
                },
                set: async (data) => {
                    try {
                        transaction(() => {
                            for (const type of Object.keys(data)) {
                                const entries = data[
                                    type as keyof SignalDataTypeMap
                                ] as Record<string, unknown> | undefined;

                                if (!entries) {
                                    continue;
                                }

                                for (const id of Object.keys(entries)) {
                                    const value = entries[id];

                                    if (value === null || value === undefined) {
                                        authRepo.deleteKey(sessionId, type, id);

                                        continue;
                                    }

                                    authRepo.setKey(
                                        sessionId,
                                        type,
                                        id,
                                        JSON.stringify(
                                            value,
                                            BufferJSON.replacer,
                                        ),
                                    );
                                }
                            }
                        });
                    } catch (error) {
                        // Perder uma gravação de chave do Signal corrompe a
                        // sessão de forma silenciosa: o WhatsApp só reclama
                        // minutos depois, com um erro de stream sem motivo.
                        log.error(
                            {
                                types: Object.keys(data),
                                err: (error as Error).message,
                            },
                            'falha ao gravar chaves do Signal',
                        );

                        throw error;
                    }
                },
            },
        },
        saveCreds,
        clear: () => authRepo.clear(sessionId),
    };
}
