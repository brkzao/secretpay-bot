/**
 * Fila serial por chave. Duas mensagens do mesmo contato chegando juntas
 * avançariam a máquina de estados em paralelo e pulariam um passo — aqui
 * elas são processadas em ordem.
 */
export class KeyedMutex {
    private readonly queues = new Map<string, Promise<unknown>>();

    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(key) ?? Promise.resolve();

        const current = previous.then(task, task);
        const settled = current.then(
            () => undefined,
            () => undefined,
        );

        this.queues.set(key, settled);

        try {
            return await current;
        } finally {
            // Libera a memória quando ninguém mais entrou na fila desta chave.
            if (this.queues.get(key) === settled) {
                this.queues.delete(key);
            }
        }
    }
}
