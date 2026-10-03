import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "../ChatMessage";
import { MessageResponse } from "../../ai-elements/message";

const render = (role: "user" | "assistant", content: string) => renderToStaticMarkup(
  React.createElement(ChatMessage, { role, content, timestamp: 1, theme: "light" }),
);

describe("chat message line breaks", () => {
  it("preserves manually entered user line breaks", () => {
    const html = render("user", "第一行\n第二行");
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("preserves multiline error text", () => {
    const html = render("assistant", "✗ 第一行\n第二行");
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("renders model soft line breaks with scoped Markdown whitespace rules", () => {
    const html = render("assistant", "第一行\n第二行");
    expect(html).toContain("whitespace-pre-line");
  });

  it("keeps Markdown paragraphs, fenced code, lists and tables", () => {
    const html = render("assistant", "段落一\n\n段落二\n\n```text\n  first\n    second\n```\n\n- alpha\n- beta\n\n| Key | Value |\n| --- | --- |\n| one | two |");
    expect(html).toContain("段落一</p>");
    expect(html).toContain("段落二</p>");
    expect(html).toContain("<pre");
    const pre = html.match(/<pre[\s\S]*?<\/pre>/)?.[0] ?? "";
    // Streamdown's highlighter renders each code line as a block span.
    expect(pre).toMatch(/> {2}first<\/span><\/span><span class="block /);
    expect(pre).toMatch(/> {4}second<\/span><\/span>/);
    expect(pre).not.toContain("<br");
    expect(html).toContain("<ul");
    expect(html).toMatch(/<li[^>]*>alpha<\/li>/);
    expect(html).toMatch(/<li[^>]*>beta<\/li>/);
    expect(html).toContain("<table");
    expect(html).toMatch(/<th[^>]*>Key<\/th>/);
    expect(html).toMatch(/<td[^>]*>two<\/td>/);
  });

  it("keeps the same break semantics through growing streaming chunks and static mode", () => {
    for (const mode of ["streaming", "static"] as const) {
      for (const content of ["第一行\n第", "第一行\n第二行", "第一行\n第二行\n第三行"]) {
        const html = renderToStaticMarkup(React.createElement(MessageResponse, { mode, children: content }));
        expect(html).toContain("whitespace-pre-line");
        expect(html.match(/<br\s*\/>/g) ?? []).toHaveLength(0);
      }
    }
  });
});
