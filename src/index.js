'use strict';

/**
 * Asyntai AI chatbot for hapi.
 *
 * Adds the Asyntai chat widget to every HTML page a hapi server sends. It uses
 * an onPreResponse extension, so it works for HTML from route handlers,
 * @hapi/vision templates and @hapi/inert files alike: the plugin puts the
 * ordinary embed loader just before </body> and changes nothing else.
 *
 * hapi compresses a response after onPreResponse, so gzip pages get the chat
 * too, wherever the plugin is registered.
 */

const fs = require('node:fs');
const pkg = require('../package.json');

const DEFAULT_SCRIPT_URL = 'https://widget.asyntai.com/static/js/chat-widget.js';
const WIDGET_ID_PATTERN = /^asyntai_[A-Za-z0-9]+$/;
const NAME = pkg.name;

/**
 * hapi registers the plugin at startup, so a wrong option stops the server
 * with a clear message instead of serving a site with no chat on it.
 */
function validateOptions(options) {
  const opts = options || {};
  const fromEnv = process.env.ASYNTAI_WIDGET_ID;
  const raw = typeof opts.widgetId === 'string' && opts.widgetId.trim()
    ? opts.widgetId
    : (typeof fromEnv === 'string' ? fromEnv : '');
  const widgetId = raw.trim();

  if (!widgetId) {
    throw new Error(
      NAME +
        ': "widgetId" is required. Copy it from the Install page of your ' +
        'Asyntai dashboard, for example asyntai_1a2b3c4d5e6f, or set the ' +
        'ASYNTAI_WIDGET_ID environment variable.',
    );
  }
  if (!WIDGET_ID_PATTERN.test(widgetId)) {
    throw new Error(
      NAME +
        ': "' +
        widgetId +
        '" does not look like a widget ID. It starts with asyntai_, for ' +
        'example asyntai_1a2b3c4d5e6f.',
    );
  }
  if (opts.shouldInject !== undefined && typeof opts.shouldInject !== 'function') {
    throw new Error(NAME + ': "shouldInject" must be a function (request) => boolean.');
  }

  const scriptUrl =
    typeof opts.scriptUrl === 'string' && opts.scriptUrl.trim()
      ? opts.scriptUrl.trim()
      : DEFAULT_SCRIPT_URL;

  return {
    widgetId,
    scriptUrl,
    shouldInject: opts.shouldInject || null,
  };
}

/** JSON.stringify, safe inside an HTML <script> element. */
function jsString(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The loader waits for the page's load event before it fetches the widget.
 * An ordinary `<script async src>` holds the load event open until its own
 * fetch finishes, so an unreachable server would delay the host page. This
 * pattern cannot.
 */
function buildLoader(widgetId, scriptUrl) {
  return (
    '(function(){var l=function(){' +
    'if(document.querySelector("script[data-asyntai-id]"))return;' +
    'var s=document.createElement("script");' +
    's.src=' +
    jsString(scriptUrl) +
    // charset: the widget script is UTF-8. Without this, a page that does not
    // declare UTF-8 itself decodes the widget's texts in the wrong encoding.
    ';s.async=true;s.charset="UTF-8";' +
    's.setAttribute("data-asyntai-id",' +
    jsString(widgetId) +
    ');' +
    'document.head.appendChild(s)};' +
    'if(document.readyState==="complete"){l()}' +
    'else{window.addEventListener("load",l)}})();'
  );
}

/**
 * The place for the tag: before the last </body>, or before </html> when the
 * page has no body tag. -1 for a fragment with neither (it is not a whole page)
 * and for a page that already carries an Asyntai snippet.
 */
function findInsertAt(html) {
  if (html.includes('data-asyntai-id') || html.includes('data-asyntai-loader')) {
    return -1;
  }
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf('</body>');
  return at !== -1 ? at : lower.lastIndexOf('</html>');
}

function injectIntoHtml(html, tag) {
  if (typeof html !== 'string') return html;
  const at = findInsertAt(html);
  return at === -1 ? html : html.slice(0, at) + tag + html.slice(at);
}

/**
 * Same, for raw bytes. latin1 maps each byte to one character, so the search
 * works on a page in any encoding and the page's own bytes are not changed.
 */
function injectIntoBuffer(buffer, tag) {
  const at = findInsertAt(buffer.toString('latin1'));
  if (at === -1) return buffer;
  return Buffer.concat([buffer.subarray(0, at), Buffer.from(tag, 'utf8'), buffer.subarray(at)]);
}

function isHtml(type) {
  return typeof type === 'string' && type.toLowerCase().includes('text/html');
}

/** True when the body is already encoded (gzip, br...) and cannot be edited as text. */
function isEncoded(response) {
  const enc = response.headers['content-encoding'];
  return typeof enc === 'string' && enc.trim() !== '' && enc.toLowerCase() !== 'identity';
}

/** Reads a whole stream into one Buffer. HTML pages are small. */
function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * The page body as it stands now, or null when this response is not an HTML
 * page. Files, views and streams are only turned into a body when they are
 * sent, so the plugin gets the body itself here.
 */
async function readPage(response) {
  const source = response.source;
  const type = response.headers['content-type'] || response.contentType;

  if (response.variety === 'plain') {
    return typeof source === 'string' && isHtml(type) ? source : null;
  }
  if (response.variety === 'buffer') {
    return isHtml(type) ? source : null;
  }
  if (response.variety === 'stream') {
    return isHtml(type) ? readStream(source) : null;
  }
  if (response.variety === 'file') {
    return isHtml(type) ? fs.promises.readFile(source.path) : null;
  }
  if (response.variety === 'view') {
    const settings = source.compiled && source.compiled.settings;
    if (!isHtml(type || (settings && settings.contentType) || 'text/html')) return null;
    return source.manager.render(source.template, source.context, source.options);
  }
  return null;
}

/**
 * The validators go too. They describe the page without the chat: a browser
 * that cached the page before the plugin was added would keep getting 304.
 */
function dropBodyHeaders(response) {
  delete response.headers['content-length'];
  delete response.headers.etag;
  delete response.headers['last-modified'];
}

async function register(server, options) {
  const settings = validateOptions(options);
  const tag =
    '<script data-asyntai-loader>' +
    buildLoader(settings.widgetId, settings.scriptUrl) +
    '</script>';

  server.ext('onPreResponse', async (request, h) => {
    const response = request.response;
    if (response.isBoom) return h.continue;
    const status = response.statusCode;
    if (status === 204 || status === 304 || status < 200 || (status >= 300 && status < 400)) return h.continue;
    if (isEncoded(response)) return h.continue;

    const page = await readPage(response);
    if (page === null) return h.continue;
    if (settings.shouldInject && !settings.shouldInject(request)) return h.continue;

    const isText = typeof page === 'string';
    const out = isText ? injectIntoHtml(page, tag) : injectIntoBuffer(page, tag);
    const changed = out !== page;

    if (response.variety === 'plain' || response.variety === 'buffer') {
      if (changed) {
        response.source = out;
        dropBodyHeaders(response);
      }
      return h.continue;
    }

    // A file, view or stream was read above, so it has to be replaced. Its own
    // type is kept: a view only sets the type when it renders.
    const next = h.response(out).code(status);
    next.type(response.headers['content-type'] || response.contentType || 'text/html');
    Object.assign(next.headers, response.headers);
    Object.assign(next.settings, response.settings);
    dropBodyHeaders(next);
    return next;
  });
}

const plugin = {
  pkg,
  requirements: { hapi: '>=20.0.0' },
  register,
};

module.exports = {
  plugin,
  default: { plugin },
  validateOptions,
  buildLoader,
  injectIntoHtml,
  injectIntoBuffer,
  DEFAULT_SCRIPT_URL,
};
