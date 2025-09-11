export function normalizeMcpContentToString(content: any): string {
  try {
    const parts: string[] = [];
    const items = Array.isArray(content?.content) ? content.content : content;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it && typeof it === "object") {
          if ("text" in it && typeof (it as any).text === "string") {
            parts.push((it as any).text);
          } else if (
            "type" in it &&
            (it as any).type === "text" &&
            typeof (it as any).text === "string"
          ) {
            parts.push((it as any).text);
          } else {
            parts.push(JSON.stringify(it));
          }
        } else if (typeof it === "string") {
          parts.push(it);
        } else {
          parts.push(String(it));
        }
      }
    } else if (typeof content === "string") {
      parts.push(content);
    } else {
      parts.push(JSON.stringify(content));
    }
    return parts.join("\n");
  } catch {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
}

export function safeParseJSON(input: string): any {
  try {
    return input ? JSON.parse(input) : {};
  } catch {
    // Best-effort: pass raw content if not valid JSON
    return input;
  }
}
