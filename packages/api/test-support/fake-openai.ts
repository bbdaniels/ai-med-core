/**
 * A fake OpenAI-compatible completion server for tests.
 *
 * The API's one gateway client (openai-clients.ts) is pointed at `url` through
 * HARVARD_GATEWAY_URL, so every chat completion, restatement and embedding the
 * server makes lands here and is recorded in `requests`, in order.
 *
 * Chat completions are answered from a queue: `enqueue(reply)` adds one reply,
 * `rejectNext(status)` makes the next chat completion fail with that status.
 * An empty queue answers with a valid structured answer, so a test only scripts
 * the turns it cares about. Embeddings always answer with a fixed 8-dimension
 * vector (as base64 float32 when the SDK asks for base64, which it does unless
 * told otherwise).
 *
 * Note that the OpenAI SDK retries 408, 409, 429 and 5xx responses itself, so a
 * rejection with one of those statuses is followed by a retry that the queue
 * answers. Use a 4xx such as 400 to make a single call fail.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMBEDDING_MODEL } from '@ai-med/chat-core';

export interface FakeToolCall {
  id?: string;
  name: string;
  arguments: object;
}

export interface FakeReply {
  /** A string is sent as is; an object is JSON-encoded, as a structured answer is. */
  content?: string | object;
  toolCalls?: FakeToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Hold the answer this long, to keep a request in flight (graceful-stop.test.ts). */
  delayMs?: number;
}

export interface FakeRequest {
  path: string;
  body: any;
}

type Queued = { kind: 'reply'; reply: FakeReply } | { kind: 'reject'; status: number; body: object };

export const FAKE_EMBEDDING: readonly number[] = [0.5, 0.25, 0.125, 0.0625, -0.5, -0.25, -0.125, -0.0625];

export const DEFAULT_ANSWER = {
  answer: 'Fixture answer from the fake gateway.',
  followups: ['Fixture follow-up one?', 'Fixture follow-up two?'],
  beyondScope: false,
};

const DEFAULT_USAGE = { prompt_tokens: 10, completion_tokens: 5 };

export class FakeOpenAI {
  url = '';
  requests: FakeRequest[] = [];
  private queue: Queued[] = [];
  private server: http.Server | null = null;
  private toolCallCounter = 0;

  enqueue(r: FakeReply): void {
    this.queue.push({ kind: 'reply', reply: r });
  }

  rejectNext(status: number, body?: object): void {
    this.queue.push({
      kind: 'reject',
      status,
      body: body ?? { error: { message: `rejected by the fake gateway (${status})`, type: 'invalid_request_error' } },
    });
  }

  /** Replies still queued; a test that scripted too many sees them here. */
  pending(): number {
    return this.queue.length;
  }

  /**
   * Forget queued replies and restart tool-call numbering, so ids a test sees
   * depend only on its own script, never on what ran before it.
   */
  clearQueue(): void {
    this.queue = [];
    this.toolCallCounter = 0;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const pathOnly = (req.url || '').split('?')[0];
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        this.requests.push({ path: pathOnly, body });
        res.setHeader('Content-Type', 'application/json');
        if (pathOnly.endsWith('/embeddings')) {
          res.end(JSON.stringify(this.embedding(body)));
          return;
        }
        if (pathOnly.endsWith('/chat/completions')) {
          const next = this.queue.shift();
          if (next?.kind === 'reject') {
            res.statusCode = next.status;
            res.end(JSON.stringify(next.body));
            return;
          }
          const answer = JSON.stringify(this.completion(next?.reply ?? { content: DEFAULT_ANSWER }, body));
          const delay = next?.reply.delayMs ?? 0;
          if (delay > 0) setTimeout(() => res.end(answer), delay).unref();
          else res.end(answer);
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: `fake gateway has no route ${pathOnly}` } }));
      });
    });
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', () => r()));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    // A held answer (delayMs) may still have its connection open.
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }

  private completion(reply: FakeReply, body: any) {
    const usage = reply.usage ?? DEFAULT_USAGE;
    const toolCalls = reply.toolCalls?.map(tc => ({
      id: tc.id ?? `call_fixture_${++this.toolCallCounter}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
    const content = reply.content === undefined
      ? (toolCalls ? null : JSON.stringify(DEFAULT_ANSWER))
      : typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
    return {
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: body?.model ?? 'gpt-4o-mini',
      choices: [{
        index: 0,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    };
  }

  private embedding(body: any) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    const base64 = body?.encoding_format === 'base64';
    const encoded = base64
      ? Buffer.from(new Float32Array(FAKE_EMBEDDING).buffer).toString('base64')
      : [...FAKE_EMBEDDING];
    return {
      object: 'list',
      model: body?.model ?? EMBEDDING_MODEL,
      data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: encoded })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    };
  }
}
