import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export function htmlToMarkdown(html) {
  const service = new TurndownService({
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  service.use(gfm);
  service.remove(["button", "svg", "style", "script"]);
  return service.turndown(html || "").trim();
}
