import { Plugin, Request } from '@hapi/hapi';

export interface HapiAiChatbotOptions {
  /**
   * Your Asyntai widget ID, for example "asyntai_1a2b3c4d5e6f".
   * Copy it from the Install page of your Asyntai dashboard.
   * If you leave it out, the plugin reads the ASYNTAI_WIDGET_ID environment variable.
   */
  widgetId?: string;
  /** Optional: return false to keep the chat off a page, for example an admin area. */
  shouldInject?: (request: Request) => boolean;
  /** Optional: a different widget script address. Leave it out to use the default. */
  scriptUrl?: string;
}

export declare const plugin: Plugin<HapiAiChatbotOptions>;

declare const hapiAiChatbot: { plugin: Plugin<HapiAiChatbotOptions> };
export default hapiAiChatbot;

export declare function validateOptions(options?: HapiAiChatbotOptions): {
  widgetId: string;
  scriptUrl: string;
  shouldInject: ((request: Request) => boolean) | null;
};
export declare function buildLoader(widgetId: string, scriptUrl: string): string;
export declare function injectIntoHtml(html: string, tag: string): string;
export declare function injectIntoBuffer(buffer: Buffer, tag: string): Buffer;
export declare const DEFAULT_SCRIPT_URL: string;
