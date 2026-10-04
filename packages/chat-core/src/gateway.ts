/**
 * The gateway contract: the names and values the API's OpenAI client
 * (openai-clients.ts, the query embedder in chat/retrieval.ts) and the Python
 * corpus builders (tools/lib/openai_gateway.py) must agree on.
 *
 * An index is embedded by a builder and queried by the API. If the two sides
 * read different variables, default to different hosts, or embed with
 * different models, nothing fails: the dense half of every search quietly
 * ranks against vectors from another space. gateway-contract.test.ts compares
 * these constants with the Python module's and pins the Python side's request
 * headers, so a change on either side is visible.
 *
 * The two sides authenticate differently on purpose: the TS client sends the
 * gateway's `api-key` header beside the SDK's `Authorization: Bearer`; Python
 * sends `Authorization: Bearer` and a User-Agent the gateway's WAF accepts.
 * Both work against the gateway today, and neither is changed without a live
 * gateway test.
 */

/** The gateway's base URL. Deliberately not OPENAI_BASE_URL, which the OpenAI SDKs read on their own. */
export const GATEWAY_URL_ENV = 'HARVARD_GATEWAY_URL';

/** The key for the gateway, or for api.openai.com when no gateway is set. */
export const API_KEY_ENV = 'OPENAI_API_KEY';

/** Where requests go when no gateway is configured. */
export const OPENAI_DIRECT_URL = 'https://api.openai.com/v1';

/** The embedding model of every readings index and every query against one. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
