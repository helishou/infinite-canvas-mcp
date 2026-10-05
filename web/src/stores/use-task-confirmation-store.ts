import { create } from "zustand";
import type { TaskConfirmationReminder } from "@/lib/confirmation-reminders";

/** Current task-center projection for reminder UI; Backend tasks remain authoritative. */
export const useTaskConfirmationStore = create<{
    projectId: string; items: TaskConfirmationReminder[];
    setSnapshot(projectId: string, items: TaskConfirmationReminder[]): void;
    clear(projectId: string): void;
}>((set, get) => ({
    projectId: "", items: [],
    setSnapshot: (projectId, items) => {
        const current = get();
        if (current.projectId === projectId && current.items.length === items.length && items.every((item, index) => current.items[index].id === item.id)) return;
        set({ projectId, items });
    },
    clear: projectId => { if (get().projectId === projectId) set({ projectId: "", items: [] }); },
}));
