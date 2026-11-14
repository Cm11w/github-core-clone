/**
 * The HTTP server: one process serving the git smart-HTTP endpoints, the
 * REST v3 API, GraphQL and MCP from a single in-memory store. Routing,
 * bearer-token authentication, body reading and reply shaping live here;
 * each surface owns its own protocol logic.
 */

import http from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { HttpError, handleRest } from './rest.ts';
import { ForgeStore } from './store.ts';

export interface AppOptions {
  /** The store the server reads and writes. Defaults to a fresh store. */
  readonly store?: ForgeStore;
  /** The login the bearer token names. Defaults to `adaiversen`. */
  readonly viewerLogin?: string;
  /**
   * The bearer token that grants access. When unset or empty, any non-empty
   * bearer token is accepted (local development); when set, the token must
   * match exactly.
   */
  readonly token?: string;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function isAuthorized(req: http.IncomingMessage, expected: string | undefined): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const presented = match[1]!;
  if (presented === '') return false;
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function sendBuffer(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extra: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, ...extra });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'the request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

function splitPath(pathname: string): string[] {
  const raw = pathname.split('/');
  raw.shift();
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const segments: string[] = [];
  for (const segment of raw) segments.push(decodeURIComponent(segment));
  return segments;
}

/** Build the HTTP server. The caller binds it and owns its lifecycle. */
export function createApp(options: AppOptions = {}): http.Server {
  const store = options.store ?? new ForgeStore(options.viewerLogin ?? 'adaiversen');
  const expectedToken = options.token;
  let requestCounter = 0;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'internal error' }, {});
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
      // eslint-disable-next-line no-console
      console.error('unhandled request error:', error instanceof Error ? error.message : String(error));
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    requestCounter += 1;
    const requestId = `forge-${requestCounter}`;
    const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
    const baseUrl = `http://${host}`;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', baseUrl);
    } catch {
      sendJson(res, 400, { message: 'the request URL is not valid' }, {});
      return;
    }
    const method = req.method ?? 'GET';
    let segments: string[];
    try {
      segments = splitPath(url.pathname);
    } catch {
      sendJson(res, 400, { message: 'the request path is not valid' }, {});
      return;
    }

    // Health: no token, always up.
    if (segments.length === 1 && segments[0] === 'healthz' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, { ok: true }, {});
      return;
    }

    // Git smart HTTP: /<owner>/<repo>.git/<info/refs|git-upload-pack|git-receive-pack>
    const gitAction =
      segments[1] !== undefined && segments[1].endsWith('.git')
        ? segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
          ? 'info/refs'
          : segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
            ? segments[2]
            : null
        : null;
    if (gitAction !== null) {
      if (!isAuthorized(req, expectedToken)) {
        sendJson(res, 401, { message: 'authentication is required' }, {});
        return;
      }
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      if (gitAction === 'info/refs') {
        if (method !== 'GET') {
          sendJson(res, 404, { message: 'Not Found' }, {});
          return;
        }
        const service = url.searchParams.get('service');
        const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
        const reply = handleInfoRefs(store, owner, repoName, service, gitProtocol);
        sendBuffer(res, reply.status, reply.contentType, reply.body, {});
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, {});
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message }, {});
          return;
        }
        throw error;
      }
      const reply =
        gitAction === 'git-upload-pack'
          ? handleUploadPack(store, owner, repoName, body)
          : handleReceivePack(store, owner, repoName, body);
      sendBuffer(res, reply.status, reply.contentType, reply.body, {});
      return;
    }

    // REST v3.
    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (!isAuthorized(req, expectedToken)) {
        sendJson(res, 401, { message: 'authentication is required' }, { 'X-GitHub-Request-Id': requestId });
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message }, { 'X-GitHub-Request-Id': requestId });
          return;
        }
        throw error;
      }
      const headers = { 'X-GitHub-Request-Id': requestId, 'X-OAuth-Scopes': 'repo, read:org' };
      try {
        const reply = handleRest({
          store,
          baseUrl,
          method,
          segments: segments.slice(2),
          query: url.searchParams,
          rawBody: body,
          path: url.pathname,
        });
        if (reply.body === undefined) {
          res.writeHead(reply.status, { ...headers, ...(reply.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, { ...headers, ...(reply.headers ?? {}) });
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message }, headers);
          return;
        }
        throw error;
      }
      return;
    }

    // GraphQL.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, {});
        return;
      }
      if (!isAuthorized(req, expectedToken)) {
        sendJson(res, 401, { message: 'authentication is required' }, {});
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message }, {});
          return;
        }
        throw error;
      }
      const reply = handleGraphql({ store, baseUrl, rawBody: body });
      sendJson(res, reply.status, reply.body, { 'X-GitHub-Request-Id': requestId });
      return;
    }

    // MCP.
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, {});
        return;
      }
      if (!isAuthorized(req, expectedToken)) {
        sendJson(res, 401, { message: 'authentication is required' }, {});
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message }, {});
          return;
        }
        throw error;
      }
      const protocolVersionHeader =
        typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;
      const reply = handleMcp({ store, baseUrl, rawBody: body, protocolVersionHeader });
      if (reply.body === undefined) {
        res.writeHead(reply.status, reply.headers ?? {});
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body, reply.headers ?? {});
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, {});
  }

  return server;
}
