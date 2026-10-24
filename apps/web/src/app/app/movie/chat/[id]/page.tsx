'use client';

import { use } from 'react';
import { ChatView } from '@/components/chat/chat-view';

export default function MovieChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ChatView sessionId={id} />;
}
