import type { Channel } from "../telegram/actions.js";

/**
 * A Channel that gathers what the bot "says" into an array instead of sending
 * it to Telegram. Lets HTTP handlers reuse the exact bot logic and return the
 * turn's messages as JSON. Inline keyboards are dropped (no web equivalent yet).
 */
export function collectingChannel(): { channel: Channel; messages: string[] } {
  const messages: string[] = [];
  const channel: Channel = {
    say: async (text: string) => {
      if (text && text.trim()) messages.push(text);
    },
    typing: async () => {},
  };
  return { channel, messages };
}
