import { describe, expect, it } from "vitest";

import { ClawChatFormatConverter } from "./format-converter";

describe("ClawChatFormatConverter", () => {
  const converter = new ClawChatFormatConverter();

  it("parses markdown into an AST", () => {
    const ast = converter.toAst("**hello**");

    expect(ast.type).toBe("root");
    expect(ast.children[0]?.type).toBe("paragraph");
  });

  it("renders markdown-compatible text from an AST", () => {
    const ast = converter.toAst("**hello**");

    expect(converter.fromAst(ast)).toContain("**hello**");
  });

  it("renders postable markdown", () => {
    expect(converter.renderPostable({ markdown: "**hello**" })).toContain("**hello**");
  });
});
