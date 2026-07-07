import {
  type AdapterPostableMessage,
  BaseFormatConverter,
  parseMarkdown,
  type Root,
  stringifyMarkdown,
} from "chat";

/**
 * ClawChat fragments carry plain text; markdown is the most portable textual
 * representation Chat SDK can render into that fragment stream.
 */
export class ClawChatFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trimEnd();
  }

  renderPostable(message: AdapterPostableMessage): string {
    return super.renderPostable(message).trimEnd();
  }
}
