'use strict';

/**
 * Tests for hapi-ai-chatbot, against a real hapi server.
 *
 * Every test builds a server, registers the plugin the way a user does, and
 * sends a request with server.inject(). No network is used.
 *
 * Run: npm test   (needs @hapi/hapi, @hapi/inert, @hapi/vision and handlebars installed)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const Hapi = require('@hapi/hapi');
const chatbot = require('../src/index.js');

const ID = 'asyntai_1a2b3c4d5e6f';
const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>';

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function serverWith(options, routes) {
  const server = Hapi.server();
  await server.register({ plugin: chatbot, options: options === undefined ? { widgetId: ID } : options });
  routes(server);
  await server.initialize();
  return server;
}

function route(server, routePath, handler, method) {
  server.route({ method: method || 'GET', path: routePath, handler });
}

/** A byte stream, as hapi accepts: Readable.from() would be in object mode. */
function pageStream() {
  return Readable.from([Buffer.from(PAGE)], { objectMode: false });
}

function pageServer(options, handler) {
  return serverWith(options, (s) => route(s, '/', handler || (() => PAGE)));
}

// ---------------------------------------------------------------- options

test('a valid widget ID is accepted and trimmed', () => {
  assert.strictEqual(chatbot.validateOptions({ widgetId: '  ' + ID + ' ' }).widgetId, ID);
});

test('a missing widget ID stops startup with a clear message', async () => {
  const saved = process.env.ASYNTAI_WIDGET_ID;
  delete process.env.ASYNTAI_WIDGET_ID;
  try {
    await assert.rejects(Hapi.server().register({ plugin: chatbot, options: {} }), /widgetId" is required/);
  } finally {
    if (saved !== undefined) process.env.ASYNTAI_WIDGET_ID = saved;
  }
});

test('a wrong widget ID stops startup', async () => {
  await assert.rejects(
    Hapi.server().register({ plugin: chatbot, options: { widgetId: 'my-widget' } }),
    /does not look like a widget ID/,
  );
});

test('the widget ID can come from ASYNTAI_WIDGET_ID, with no options at all', async () => {
  process.env.ASYNTAI_WIDGET_ID = 'asyntai_fromenv123';
  try {
    const server = Hapi.server();
    await server.register(chatbot);
    route(server, '/', () => PAGE);
    const res = await server.inject('/');
    assert.ok(res.payload.includes('"asyntai_fromenv123"'));
  } finally {
    delete process.env.ASYNTAI_WIDGET_ID;
  }
});

test('the widgetId option wins over the environment variable', async () => {
  process.env.ASYNTAI_WIDGET_ID = 'asyntai_fromenv123';
  try {
    const server = await pageServer({ widgetId: ID });
    const res = await server.inject('/');
    assert.ok(res.payload.includes('"' + ID + '"'));
    assert.ok(!res.payload.includes('fromenv'));
  } finally {
    delete process.env.ASYNTAI_WIDGET_ID;
  }
});

test('shouldInject must be a function', async () => {
  await assert.rejects(
    Hapi.server().register({ plugin: chatbot, options: { widgetId: ID, shouldInject: 'admin' } }),
    /shouldInject" must be a function/,
  );
});

test('the ES module default export registers too', async () => {
  const server = Hapi.server();
  await server.register({ plugin: chatbot.default, options: { widgetId: ID } });
  route(server, '/', () => PAGE);
  assert.ok((await server.inject('/')).payload.includes('data-asyntai-loader'));
});

// ---------------------------------------------------------------- HTML pages

test('an HTML string gets the loader once, just before </body>', async () => {
  const server = await pageServer();
  const res = await server.inject('/');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(count(res.payload, 'data-asyntai-loader'), 1);
  assert.ok(res.payload.indexOf('data-asyntai-loader') < res.payload.indexOf('</body>'));
  assert.ok(res.payload.includes('https://widget.asyntai.com/static/js/chat-widget.js'));
  assert.ok(res.payload.includes('"' + ID + '"'));
  assert.ok(res.headers['content-type'].includes('text/html'));
});

test('the loader sets charset UTF-8 on the widget script', async () => {
  const server = await pageServer();
  assert.ok((await server.inject('/')).payload.includes('s.charset="UTF-8"'));
});

test('the Content-Length header matches the new body', async () => {
  const server = await pageServer(undefined, (req, h) => h.response(PAGE).type('text/html').bytes(Buffer.byteLength(PAGE)));
  const res = await server.inject('/');
  assert.ok(res.payload.includes('data-asyntai-loader'));
  assert.strictEqual(Number(res.headers['content-length']), Buffer.byteLength(res.payload));
});

test('an HTML Buffer gets the loader, and non-ASCII text survives', async () => {
  const page = PAGE.replace('Hi', 'Dobrý den, žluťoučký kůň');
  const server = await pageServer(undefined, (req, h) => h.response(Buffer.from(page)).type('text/html; charset=utf-8'));
  const res = await server.inject('/');
  assert.ok(res.payload.includes('data-asyntai-loader'));
  assert.ok(res.payload.includes('žluťoučký kůň'));
  assert.strictEqual(Number(res.headers['content-length']), res.rawPayload.length);
});

test('a page in another encoding keeps its own bytes', async () => {
  const page = Buffer.concat([Buffer.from('<html><body>'), Buffer.from([0xe8, 0xe9]), Buffer.from('</body></html>')]);
  const server = await pageServer(undefined, (req, h) => h.response(page).type('text/html; charset=iso-8859-2'));
  const res = await server.inject('/');
  assert.ok(res.rawPayload.includes(Buffer.from([0x3e, 0xe8, 0xe9])));
  assert.ok(res.payload.includes('data-asyntai-loader'));
});

test('a page with an upper-case </BODY> is handled', async () => {
  const server = await pageServer(undefined, () => '<HTML><BODY>x</BODY></HTML>');
  const res = await server.inject('/');
  assert.ok(res.payload.indexOf('data-asyntai-loader') < res.payload.indexOf('</BODY>'));
});

test('a page with no <body> gets the loader before </html>', async () => {
  const server = await pageServer(undefined, () => '<html><p>x</p></html>');
  const res = await server.inject('/');
  assert.ok(res.payload.indexOf('data-asyntai-loader') < res.payload.indexOf('</html>'));
});

test('an HTML fragment (no </body>, no </html>) is left alone', async () => {
  const server = await pageServer(undefined, () => '<li>item</li>');
  assert.strictEqual((await server.inject('/')).payload, '<li>item</li>');
});

test('a page that already has the Asyntai snippet is left alone', async () => {
  const own = PAGE.replace('</body>', '<script async src="x" data-asyntai-id="' + ID + '"></script></body>');
  const server = await pageServer(undefined, () => own);
  assert.strictEqual((await server.inject('/')).payload, own);
});

test('a stream with an HTML type gets the loader', async () => {
  const server = await pageServer(undefined, (req, h) => h.response(pageStream()).type('text/html'));
  const res = await server.inject('/');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(count(res.payload, 'data-asyntai-loader'), 1);
  assert.ok(res.headers['content-type'].includes('text/html'));
});

test('headers and cookies set by the handler stay', async () => {
  const server = await serverWith(undefined, (s) => {
    s.state('seen', { isSecure: false, isHttpOnly: false, path: '/' });
    route(s, '/', (req, h) => h.response(pageStream()).type('text/html').header('x-own', 'yes').state('seen', '1'));
  });
  const res = await server.inject('/');
  assert.strictEqual(res.headers['x-own'], 'yes');
  assert.ok(String(res.headers['set-cookie']).includes('seen=1'));
  assert.ok(res.payload.includes('data-asyntai-loader'));
});

// ---------------------------------------------------------------- not HTML

test('JSON responses are not changed', async () => {
  const server = await serverWith(undefined, (s) => route(s, '/api', () => ({ html: '</body>' })));
  assert.deepStrictEqual(JSON.parse((await server.inject('/api')).payload), { html: '</body>' });
});

test('plain text with </body> in it is not changed', async () => {
  const server = await serverWith(undefined, (s) => route(s, '/t', (req, h) => h.response(PAGE).type('text/plain')));
  assert.strictEqual((await server.inject('/t')).payload, PAGE);
});

test('a stream that is not HTML is not read or changed', async () => {
  const server = await serverWith(undefined, (s) => route(s, '/s', (req, h) => h.response(pageStream()).type('text/plain')));
  assert.strictEqual((await server.inject('/s')).payload, PAGE);
});

test('204 and 304 responses are not changed', async () => {
  const server = await serverWith(undefined, (s) => {
    route(s, '/204', (req, h) => h.response().code(204));
    route(s, '/304', (req, h) => h.response().code(304).type('text/html'));
  });
  assert.strictEqual((await server.inject('/204')).payload, '');
  assert.strictEqual((await server.inject('/304')).payload, '');
});

test('an HTML redirect body is not changed', async () => {
  const server = await serverWith(undefined, (s) => route(s, '/r', (req, h) => h.response(PAGE).code(302).header('location', '/')));
  const res = await server.inject('/r');
  assert.strictEqual(res.statusCode, 302);
  assert.ok(!res.payload.includes('data-asyntai-loader'));
});

test("hapi's own 404 and 500 JSON errors are not changed", async () => {
  const server = await serverWith(undefined, (s) => route(s, '/boom', () => { throw new Error('x'); }));
  assert.strictEqual(JSON.parse((await server.inject('/missing')).payload).statusCode, 404);
  assert.strictEqual(JSON.parse((await server.inject('/boom')).payload).statusCode, 500);
});

test('a HEAD request returns no body and the length of the GET page', async () => {
  const server = await pageServer();
  const get = await server.inject('/');
  const head = await server.inject({ method: 'HEAD', url: '/' });
  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(head.payload, '');
  assert.strictEqual(head.headers['content-length'], get.headers['content-length']);
});

// ---------------------------------------------------------------- scope and options

test('routes of other plugins and prefixes get the chat too', async () => {
  const server = Hapi.server();
  await server.register({ plugin: chatbot, options: { widgetId: ID } });
  await server.register(
    { plugin: { name: 'shop', register: (s) => route(s, '/page', () => PAGE) } },
    { routes: { prefix: '/shop' } },
  );
  assert.ok((await server.inject('/shop/page')).payload.includes('data-asyntai-loader'));
});

test('shouldInject can keep the chat off some pages', async () => {
  const server = await serverWith(
    { widgetId: ID, shouldInject: (request) => !request.path.startsWith('/admin') },
    (s) => {
      route(s, '/', () => PAGE);
      route(s, '/admin', () => PAGE);
    },
  );
  assert.ok((await server.inject('/')).payload.includes('data-asyntai-loader'));
  assert.ok(!(await server.inject('/admin')).payload.includes('data-asyntai-loader'));
});

test('an HTML 404 page from a catch-all route gets the chat', async () => {
  const server = await serverWith(undefined, (s) =>
    route(s, '/{any*}', (req, h) => h.response(PAGE).code(404), '*'),
  );
  const res = await server.inject('/missing');
  assert.strictEqual(res.statusCode, 404);
  assert.ok(res.payload.includes('data-asyntai-loader'));
});

test('an HTML error page from an earlier onPreResponse gets the chat', async () => {
  const server = Hapi.server();
  server.ext('onPreResponse', (request, h) =>
    request.response.isBoom ? h.response(PAGE).code(request.response.output.statusCode) : h.continue,
  );
  await server.register({ plugin: chatbot, options: { widgetId: ID } });
  const res = await server.inject('/missing');
  assert.strictEqual(res.statusCode, 404);
  assert.ok(res.payload.includes('data-asyntai-loader'));
});

test('a custom scriptUrl is used and cannot break out of the <script>', async () => {
  const server = await pageServer({ widgetId: ID, scriptUrl: 'https://cdn.example.com/w.js?</script><b>' });
  const res = await server.inject('/');
  assert.ok(res.payload.includes('https://cdn.example.com/w.js?\\u003c/script>\\u003cb>'));
  assert.strictEqual(count(res.payload, '</script>'), 1);
});

// ---------------------------------------------------------------- with other plugins

function staticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asyntai-hapi-'));
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.writeFileSync(path.join(dir, 'about.html'), PAGE.replace('Hi', 'About'));
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(dir, 'home.hbs'), '<html><body><h1>{{title}}</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'feed.hbs'), '<feed>{{title}}</body></feed>');
  return dir;
}

async function inertServer(dir, routes) {
  const server = Hapi.server({ routes: { files: { relativeTo: dir } } });
  await server.register(require('@hapi/inert'));
  await server.register({ plugin: chatbot, options: { widgetId: ID } });
  routes(server);
  await server.initialize();
  return server;
}

test('@hapi/inert directory: HTML files get the chat, other files do not', async () => {
  const dir = staticDir();
  const server = await inertServer(dir, (s) =>
    s.route({ method: 'GET', path: '/{p*}', handler: { directory: { path: '.', index: true } } }),
  );

  const home = await server.inject('/');
  assert.strictEqual(home.statusCode, 200);
  assert.strictEqual(count(home.payload, 'data-asyntai-loader'), 1);
  assert.strictEqual(Number(home.headers['content-length']), Buffer.byteLength(home.payload));
  assert.ok(home.headers['content-type'].includes('text/html'));

  const about = await server.inject('/about.html');
  assert.ok(about.payload.includes('About'));
  assert.ok(about.payload.includes('data-asyntai-loader'));

  const css = await server.inject('/style.css');
  assert.strictEqual(css.payload, 'body{color:red}');
  assert.ok(css.headers['content-type'].includes('text/css'));
});

test('@hapi/inert h.file() in a handler gets the chat', async () => {
  const dir = staticDir();
  const server = await inertServer(dir, (s) => route(s, '/', (req, h) => h.file('index.html')));
  assert.ok((await server.inject('/')).payload.includes('data-asyntai-loader'));
});

test('a browser with an old cached file gets the page with the chat, not a 304', async () => {
  const dir = staticDir();
  const server = await inertServer(dir, (s) => route(s, '/', (req, h) => h.file('index.html')));
  const res = await server.inject({ url: '/', headers: { 'if-modified-since': new Date(Date.now() + 86400000).toUTCString() } });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.payload.includes('data-asyntai-loader'));
});

async function viewServer(dir, options, routes) {
  const server = Hapi.server();
  await server.register(require('@hapi/vision'));
  await server.register({ plugin: chatbot, options: { widgetId: ID } });
  server.views({ engines: { hbs: require('handlebars') }, relativeTo: dir, path: '.', ...options });
  routes(server);
  await server.initialize();
  return server;
}

test('@hapi/vision templates get the chat', async () => {
  const dir = staticDir();
  const server = await viewServer(dir, {}, (s) => route(s, '/', (req, h) => h.view('home', { title: 'Shop' })));
  const res = await server.inject('/');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.payload.includes('<h1>Shop</h1>'));
  assert.strictEqual(count(res.payload, 'data-asyntai-loader'), 1);
  assert.ok(res.headers['content-type'].includes('text/html'));
});

test('@hapi/vision: the global context is still used', async () => {
  const dir = staticDir();
  const server = await viewServer(dir, { context: { title: 'From global' } }, (s) => route(s, '/', (req, h) => h.view('home')));
  assert.ok((await server.inject('/')).payload.includes('<h1>From global</h1>'));
});

test('@hapi/vision: a non-HTML view is not changed', async () => {
  const dir = staticDir();
  const server = await viewServer(dir, {}, (s) => route(s, '/', (req, h) => h.view('feed', { title: 'x' }).type('application/xml')));
  const res = await server.inject('/');
  assert.strictEqual(res.payload, '<feed>x</body></feed>');
});

test('gzip pages get the chat, for a string and for a file', async () => {
  const big = PAGE.replace('Hi', 'x'.repeat(2000));
  const dir = staticDir();
  fs.writeFileSync(path.join(dir, 'big.html'), big);
  const server = await inertServer(dir, (s) => {
    route(s, '/string', () => big);
    route(s, '/file', (req, h) => h.file('big.html'));
  });
  for (const url of ['/string', '/file']) {
    const res = await server.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(res.headers['content-encoding'], 'gzip', url);
    assert.strictEqual(count(zlib.gunzipSync(res.rawPayload).toString('utf8'), 'data-asyntai-loader'), 1, url);
  }
});

test('a body the handler already compressed is passed through unharmed', async () => {
  const gz = zlib.gzipSync(PAGE);
  const server = await pageServer(undefined, (req, h) => h.response(gz).type('text/html').header('content-encoding', 'gzip'));
  const res = await server.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(zlib.gunzipSync(res.rawPayload).toString('utf8'), PAGE);
});
