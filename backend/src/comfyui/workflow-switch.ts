/** Shared by built-in presets and imported workflows, scoped to a ComfyUI endpoint. */
export class ComfyWorkflowSwitch {
    private endpoints = new Map<string, { previous?: string; tail: Promise<unknown> }>();

    async submit<T>(url: string, workflow: string, submit: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const endpoint = url.replace(/\/+$/, "");
        let state = this.endpoints.get(endpoint);
        if (!state) {
            state = { tail: Promise.resolve() };
            this.endpoints.set(endpoint, state);
        }
        const current = state;
        const result = current.tail.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            if (current.previous !== undefined && current.previous !== workflow) {
                const response = await fetch(`${endpoint}/free`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ unload_models: true, free_memory: true }),
                    signal,
                });
                if (!response.ok) throw new Error(`ComfyUI /free failed: HTTP ${response.status}`);
            }
            signal?.throwIfAborted();
            const value = await submit();
            current.previous = workflow;
            return value;
        });
        current.tail = result;
        return result;
    }
}

export const comfyWorkflowSwitch = new ComfyWorkflowSwitch();
