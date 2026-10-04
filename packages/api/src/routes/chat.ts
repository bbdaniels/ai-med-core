/**
 * POST /api/chat: a thin route over the engine's runChatTurn. It reads the
 * project's chat config, picks the app's hooks (document chat or the
 * simulator), and hands the pipeline the engine store and a client chosen by
 * the project's payment source. Every error string and status is the
 * pipeline's or the route's as before; the guards (rate limits, access code,
 * public-chat switch) are the server's and run in the order it passes them.
 */
import express from 'express';
import path from 'path';
import {
  clientForPaymentSource,
  DirectKeyMissingError,
  openReadingsIndex,
  loadChatProjectConfig,
  talkHooks,
  runChatTurn,
  ChatInputError,
  resolveDocumentKey,
  type ChatRequestBody,
} from '@ai-med/chat-core';
import { activeProjectPrefix, engineStore, getCaseTemplate, getProjectSetting } from '../database.js';
import { REPO_ROOT } from '../repo-root.js';
import { simulationHooks } from '../sim/hooks.js';

export function chatRouter(guards: express.RequestHandler[]): express.Router {
  const router = express.Router();

  router.post('/api/chat', ...guards, async (req, res) => {
    try {
      const body = (req.body ?? {}) as ChatRequestBody;
      const { messages, language, sessionToken } = body;
      // documentKey, or vignetteKey as every deployed page sends it (chat-core chat/request.ts).
      const documentKey = resolveDocumentKey(body);
      const usageProject = activeProjectPrefix();
      const slug = (usageProject || '').replace(/_+$/, '');
      const config = await loadChatProjectConfig(REPO_ROOT, slug || 'demo', usageProject);

      const turn = await runChatTurn({ messages, documentKey, language, sessionToken }, {
        repoRoot: REPO_ROOT,
        config,
        store: engineStore,
        hooks: config.app === 'talk'
          ? talkHooks()
          : simulationHooks({ getCaseTemplate, transcriptsDir: path.resolve(REPO_ROOT, 'transcripts') }),
        now: () => new Date(),
        // Billed per project: the payment source picks the client for this request.
        client: async () => clientForPaymentSource(await getProjectSetting(slug || 'default', 'payment_source')),
        openIndex: cfg => (cfg.readingsIndexPath ? openReadingsIndex(REPO_ROOT, cfg.slug, cfg.readingsIndexPath) : null),
      });

      res.json({
        message: turn.message,
        followups: turn.followups,
        beyondScope: turn.beyondScope,
        usage: turn.usage,
        caseTemplate: turn.caseTemplate,
      });
    } catch (error) {
      if (error instanceof ChatInputError) return res.status(error.status).json({ error: error.message });
      if (error instanceof DirectKeyMissingError) return res.status(503).json({ error: error.message });
      console.error('OpenAI API error:', error);
      res.status(500).json({
        error: 'Failed to generate response',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  return router;
}
