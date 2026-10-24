import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { chatAction, createChatSession, deleteChatSession, getChatSession, listChatSessions, postChatMessage } from '../../chat/chat';

const idParam = z.object({ id: z.string().uuid() });
const kind = z.enum(['movie', 'ad']);

/** Chat mode: AI Movie Maker and Ad Studio conversations. */
export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  // Each message is one AI Director call (plus a page read for pasted links), so keep it modest.
  const chatLimit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 20, timeWindow: '1 minute' } } };

  app.get('/api/chat/sessions', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ kind: kind.optional() }), req.query);
    return { sessions: await listChatSessions(ctx, u, q.kind) };
  });

  app.post('/api/chat/sessions', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ kind }), req.body);
    return reply.status(201).send(await createChatSession(ctx, u, body.kind));
  });

  app.get('/api/chat/sessions/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return getChatSession(ctx, u, id);
  });

  app.delete('/api/chat/sessions/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await deleteChatSession(ctx, u, id);
    return reply.status(204).send();
  });

  app.post('/api/chat/sessions/:id/messages', chatLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        content: z.string().max(4000).default(''),
        attachments: z.array(z.object({ assetId: z.string().uuid(), kind: z.enum(['photo', 'logo', 'product']).optional(), note: z.string().max(120).optional() })).max(8).default([]),
      }),
      req.body,
    );
    await postChatMessage(ctx, u, id, body);
    return getChatSession(ctx, u, id);
  });

  app.post('/api/chat/sessions/:id/actions', chatLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ type: z.enum(['approve_screenplay', 'generation_started', 'choose_concept', 'new_concepts']), index: z.number().int().min(0).max(5).optional() }), req.body);
    await chatAction(ctx, u, id, body);
    return getChatSession(ctx, u, id);
  });
}
