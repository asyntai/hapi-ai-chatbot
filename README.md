# hapi-ai-chatbot

Add the [Asyntai](https://asyntai.com) AI chat assistant to every HTML page of
your hapi server. It answers visitor questions from your own content, in more
than 80 languages.

Full guide: https://asyntai.com/documentation/integrations/hapi/

## Install

```bash
npm install hapi-ai-chatbot
```

## Use

```js
const Hapi = require('@hapi/hapi');

const init = async () => {
  const server = Hapi.server({ port: 3000 });

  await server.register({
    plugin: require('hapi-ai-chatbot'),
    options: { widgetId: 'asyntai_1a2b3c4d5e6f' },
  });

  server.route({
    method: 'GET',
    path: '/',
    handler: () => '<html><body><h1>Hello</h1></body></html>',
  });

  await server.start();
};

init();
```

ES modules and TypeScript:

```js
import Hapi from '@hapi/hapi';
import aiChatbot from 'hapi-ai-chatbot';

const server = Hapi.server({ port: 3000 });
await server.register({ plugin: aiChatbot, options: { widgetId: 'asyntai_1a2b3c4d5e6f' } });
```

Open any page of your site. The chat bubble is in the corner.

## Where the widget ID comes from

Open the Install page in your [Asyntai dashboard](https://asyntai.com/dashboard).
The widget ID is the value of `data-asyntai-id` in the snippet. It starts with
`asyntai_`. If you leave `widgetId` out, the plugin reads the
`ASYNTAI_WIDGET_ID` environment variable.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `widgetId` | string | `ASYNTAI_WIDGET_ID` | Your Asyntai widget ID |
| `shouldInject` | `(request) => boolean` | every page | Return `false` to keep the chat off a page |
| `scriptUrl` | string | the Asyntai CDN | Advanced. Load the widget from another URL |

A missing or malformed widget ID stops the server at startup with a clear
message.

Keep the chat off admin pages:

```js
await server.register({
  plugin: require('hapi-ai-chatbot'),
  options: {
    widgetId: 'asyntai_1a2b3c4d5e6f',
    shouldInject: (request) => !request.path.startsWith('/admin'),
  },
});
```

## How it works

The plugin adds an `onPreResponse` extension and puts the Asyntai loader just
before `</body>` of every HTML response. It works for HTML from route handlers,
`@hapi/vision` templates and `@hapi/inert` files, in every route and every
plugin of the server. JSON, non-HTML files, redirects, `204` and `304` responses
are not changed. A page that already has the Asyntai snippet is left alone.

hapi compresses a response after this step, so gzip pages get the chat too.

The loader waits for the page's `load` event, so your page always renders
first.

If another `onPreResponse` extension of yours makes HTML error pages, add it
before this plugin. Extensions run in the order you add them.

## Compatibility

hapi 20 and 21, Node 18 or later.

## Tests

```bash
npm install
npm test
```

## License

MIT
