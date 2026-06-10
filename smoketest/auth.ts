// auth + rover profile REST smoke test. node-side fetch only, no browser.
// assumes the server is running (npm start / npm run server) on :8080.
//
// run with FREEKNET_LLM_MOCK=1 on the server so the api key check doesn't
// hit openrouter for real, and FREEKNET_AUTH_WINDOW_MS=5000 so the rate-limit
// flood at the end doesn't lock out suites that run after this one.

import { makeRunner } from './helpers';

const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:8080';

// minimal cookie jar: one session cookie is all we need.
class Client {
  cookie = '';

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(API_URL + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let json: any = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }
}

// 1x1 transparent png
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  const r = makeRunner();
  const username = `smoke_${Date.now().toString(36)}`;
  const password = 'hunter22hunter22';
  const c = new Client();

  await r.test('register validation', async () => {
    const bad = await new Client().req('POST', '/api/register', { username: 'x', password });
    r.expect(bad.status === 400, `short username rejected (got ${bad.status})`);
    const badPw = await new Client().req('POST', '/api/register', { username, password: 'short' });
    r.expect(badPw.status === 400, `short password rejected (got ${badPw.status})`);
    r.pass('bad inputs rejected');
  });

  await r.test('register + me', async () => {
    const reg = await c.req('POST', '/api/register', { username, password });
    r.expect(reg.status === 200, `register ok (got ${reg.status}: ${JSON.stringify(reg.json)})`);
    r.expect(c.cookie.startsWith('fk_session='), 'session cookie set');
    const me = await c.req('GET', '/api/me');
    r.expect(me.status === 200 && me.json.username === username, 'me returns username');
    r.expect(me.json.rover === null, 'no rover yet');
    r.expect(me.json.hasApiKey === false, 'no api key yet');
    r.pass('registered and session works');
  });

  await r.test('duplicate username rejected', async () => {
    const dup = await new Client().req('POST', '/api/register', { username, password });
    r.expect(dup.status === 409, `duplicate username 409 (got ${dup.status})`);
    r.pass('409 on duplicate');
  });

  await r.test('rover upsert', async () => {
    const noDraw = await c.req('PUT', '/api/rover', { active: true });
    r.expect(noDraw.status === 400, 'cannot activate rover without a drawing');
    const put = await c.req('PUT', '/api/rover', {
      drawing: TINY_PNG,
      personality: 'a curious little squiggle who loves movies',
      intentShort: 'today: chinese tea',
      intentLong: 'find a film club',
      active: true,
    });
    r.expect(put.status === 200, `rover saved (got ${put.status}: ${JSON.stringify(put.json)})`);
    r.expect(put.json.rover?.active === true, 'rover active');
    r.expect(put.json.rover?.intentShort === 'today: chinese tea', 'intent saved');
    const longPersonality = await c.req('PUT', '/api/rover', { personality: 'x'.repeat(2000) });
    r.expect(
      longPersonality.json.rover?.personality.length === 500,
      'personality capped at 500 chars',
    );
    r.pass('rover profile round-trips with caps');
  });

  await r.test('api key never echoed', async () => {
    const put = await c.req('PUT', '/api/rover/key', { apiKey: 'sk-or-test-abc123' });
    r.expect(put.status === 200, `key stored (got ${put.status}) — is FREEKNET_LLM_MOCK=1 set?`);
    r.expect(put.json.hasApiKey === true, 'hasApiKey true');
    const raw = JSON.stringify(put.json) + JSON.stringify((await c.req('GET', '/api/me')).json);
    r.expect(!raw.includes('sk-or-test'), 'key text never appears in responses');
    const del = await c.req('DELETE', '/api/rover/key');
    r.expect(del.json.hasApiKey === false, 'key removable');
    r.pass('key stored, hidden, removable');
  });

  await r.test('login/logout', async () => {
    const fresh = new Client();
    const badLogin = await fresh.req('POST', '/api/login', { username, password: 'wrongwrong' });
    r.expect(badLogin.status === 401, 'wrong password 401');
    const login = await fresh.req('POST', '/api/login', { username, password });
    r.expect(login.status === 200, 'login ok');
    const out = await fresh.req('POST', '/api/logout');
    r.expect(out.status === 200, 'logout ok');
    const me = await fresh.req('GET', '/api/me');
    r.expect(me.status === 401, 'session dead after logout');
    r.pass('login lifecycle works');
  });

  await r.test('rover deactivates for cleanup', async () => {
    // leave the dev db tidy: an active rover would wander every later test run
    const off = await c.req('PUT', '/api/rover', { active: false });
    r.expect(off.status === 200 && off.json.rover?.active === false, 'rover off');
    r.pass('dev world left clean');
  });

  await r.test('auth rate limit', async () => {
    const flood = new Client();
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await flood.req('POST', '/api/login', { username, password: 'wrongwrong' });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    r.expect(got429, 'rate limiter returns 429 under flood');
    r.pass('rate limited');
  });

  process.exit(r.summary() ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
