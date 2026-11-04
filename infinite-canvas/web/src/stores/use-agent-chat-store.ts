import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import type { AgentChatMessageItem } from "@/components/agent/agent-chat-message";

export type AgentConversation = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: AgentChatMessageItem[];
};

type AgentChatStore = {
    conversations: AgentConversation[];
    activeId: string;
    hydrated: boolean;
    setHydrated: (hydrated: boolean) => void;
    createConversation: () => string;
    selectConversation: (id: string) => void;
    deleteConversation: (id: string) => void;
    saveMessages: (id: string, messages: AgentChatMessageItem[]) => void;
};

const NEW_CHAT_TITLE = "新对话";

function conversationId() {
    return `agent-chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function blankConversation(): AgentConversation {
    const now = Date.now();
    return { id: conversationId(), title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, messages: [] };
}

function storedMessage(message: AgentChatMessageItem): AgentChatMessageItem {
    return { id: message.id, role: message.role, title: message.title, text: message.text, meta: message.meta, reasoning: message.reasoning };
}

function titleFromMessages(messages: AgentChatMessageItem[]) {
    const firstUser = messages.find((message) => message.role === "user" && message.text.trim());
    return firstUser ? firstUser.text.trim().slice(0, 24) : NEW_CHAT_TITLE;
}

const first = blankConversation();

export const useAgentChatStore = create<AgentChatStore>()(
    persist(
        (set, get) => ({
            conversations: [first],
            activeId: first.id,
            hydrated: false,
            setHydrated: (hydrated) => set({ hydrated }),
            createConversation: () => {
                const conversation = blankConversation();
                set((state) => ({ conversations: [conversation, ...state.conversations].slice(0, 40), activeId: conversation.id }));
                return conversation.id;
            },
            selectConversation: (id) => {
                if (get().conversations.some((conversation) => conversation.id === id)) set({ activeId: id });
            },
            deleteConversation: (id) => {
                const state = get();
                const remaining = state.conversations.filter((conversation) => conversation.id !== id);
                if (!remaining.length) {
                    const conversation = blankConversation();
                    set({ conversations: [conversation], activeId: conversation.id });
                    return;
                }
                set({ conversations: remaining, activeId: state.activeId === id ? remaining[0].id : state.activeId });
            },
            saveMessages: (id, messages) => {
                if (!get().hydrated) return;
                set((state) => ({
                    conversations: state.conversations.map((conversation) =>
                        conversation.id === id
                            ? {
                                  ...conversation,
                                  title: conversation.title === NEW_CHAT_TITLE || !conversation.messages.length ? titleFromMessages(messages) : conversation.title,
                                  updatedAt: Date.now(),
                                  messages: messages.map(storedMessage),
                              }
                            : conversation,
                    ),
                }));
            },
        }),
        {
            name: "infinite-canvas:agent_chat_store",
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ conversations: state.conversations, activeId: state.activeId }),
            onRehydrateStorage: () => (state) => state?.setHydrated(true),
        },
    ),
);
