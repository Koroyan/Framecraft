'use client';

import { ChatHome } from '@/components/chat/chat-view';
import { MovieModeSwitch } from '@/components/chat/mode-switch';

export default function MovieChatHome() {
  return (
    <div className="space-y-5">
      <MovieModeSwitch mode="chat" />
      <ChatHome kind="movie" />
    </div>
  );
}
