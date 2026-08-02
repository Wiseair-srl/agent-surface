import { describe, expect, it } from "vitest";
import { installDom } from "../src/dom.js";

describe("the CLI DOM realm", () => {
  it("constructs global events in the same realm as jsdom nodes (#43)", () => {
    class ForeignEvent {}
    class ForeignCustomEvent extends ForeignEvent {}
    Object.defineProperty(globalThis, "Event", {
      value: ForeignEvent,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "CustomEvent", {
      value: ForeignCustomEvent,
      writable: true,
      configurable: true,
    });

    installDom();

    expect(globalThis.Event).toBe(window.Event);
    expect(globalThis.CustomEvent).toBe(window.CustomEvent);
    expect(() =>
      document.createElement("div").dispatchEvent(new CustomEvent("radix-focus-scope")),
    ).not.toThrow();
  });
});
