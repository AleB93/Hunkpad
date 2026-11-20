import { describe, expect, it } from "vitest";
import { ClaudeError, FLOW_MODES, flowPrompt, parseFlow } from "../src/claude";

describe("Code to flow: Claude's answer", () => {
  it("accepts a flowchart (flowchart or graph), and strips stray code fences", () => {
    const a = parseFlow({ title: "Login", mermaid: "```mermaid\nflowchart TD\n  A-->B\n```", explanation: "Steps." }, "flow");
    expect(a.mermaid).toBe("flowchart TD\n  A-->B");
    expect(parseFlow({ title: "x", mermaid: "%% c\ngraph LR\nA-->B", explanation: "" }, "flow").mermaid).toMatch(/^%% c/);
  });

  it("rejects a diagram of the wrong kind", () => {
    expect(() => parseFlow({ title: "x", mermaid: "sequenceDiagram\nA->>B: hi", explanation: "" }, "flow")).toThrow(ClaudeError);
    expect(() => parseFlow({ title: "x", mermaid: "flowchart TD\nA-->B", explanation: "" }, "class")).toThrow(/classDiagram/);
  });

  it("accepts sequence and class diagrams for their modes", () => {
    expect(parseFlow({ title: "x", mermaid: "sequenceDiagram\nA->>B: hi", explanation: "" }, "sequence").mermaid).toContain("A->>B");
    expect(parseFlow({ title: "x", mermaid: "classDiagram\nclass A", explanation: "" }, "class").mermaid).toContain("class A");
  });

  it("Explain only drops any diagram; a missing answer is an error", () => {
    expect(parseFlow({ title: "x", mermaid: "flowchart TD\nA", explanation: "Walkthrough" }, "explain")).toEqual({
      title: "x",
      mermaid: "",
      explanation: "Walkthrough",
    });
    expect(() => parseFlow({ title: "x" }, "flow")).toThrow(ClaudeError);
    expect(parseFlow({ title: " ", mermaid: "flowchart TD", explanation: "" }, "flow").title).toBe("Code flow");
  });

  it("asks for the diagram type of each mode, with the changes after it", () => {
    for (const m of FLOW_MODES) {
      const p = flowPrompt(m.id, "CHANGES");
      expect(p.endsWith("CHANGES")).toBe(true);
      if (m.diagram) expect(p).toContain(m.diagram === "flowchart" ? "flowchart TD" : m.diagram);
    }
  });
});
