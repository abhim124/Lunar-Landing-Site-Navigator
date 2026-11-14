'use client';

import { create } from 'zustand';
import { CHAT_BACKEND_ENABLED, buildMissionContext, sendChat, type ChatMessage } from '@/lib/chatClient';
import { errorMessage } from '@/lib/api';
import { useMissionStore } from './useMissionStore';

const NOT_CONNECTED =
  "The AI assistant isn't connected yet. Your question is saved here and will be answered once the chat backend and its API key are set up.";

interface ChatState {
  isOpen: boolean;
  messages: ChatMessage[];
  pending: boolean;
  setOpen: (open: boolean) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
}

let seq = 0;
const msg = (role: ChatMessage['role'], text: string): ChatMessage => ({ id: `m${Date.now()}-${seq++}`, role, text, createdAt: Date.now() });

export const useChatStore = create<ChatState>()((set, get) => ({
  isOpen: false,
  messages: [],
  pending: false,
  setOpen: (open) => set({ isOpen: open }),
  clear: () => set({ messages: [] }),
  send: async (raw) => {
    const text = raw.trim();
    if (!text || get().pending) return;
    set((s) => ({ messages: [...s.messages, msg('user', text)] }));

    if (!CHAT_BACKEND_ENABLED) {
      set((s) => ({ messages: [...s.messages, msg('notice', NOT_CONNECTED)] }));
      return;
    }

    set({ pending: true });
    try {
      const history = get()
        .messages.filter((m) => m.role !== 'notice')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }));
      const res = await sendChat({ messages: history, context: buildMissionContext(useMissionStore.getState()) });
      set((s) => ({ messages: [...s.messages, msg('assistant', res.reply)] }));
    } catch (err) {
      set((s) => ({ messages: [...s.messages, msg('notice', `Couldn't reach the assistant: ${errorMessage(err)}`)] }));
    } finally {
      set({ pending: false });
    }
  },
}));
