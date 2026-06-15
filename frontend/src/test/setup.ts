import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// globals:false means Testing Library can't auto-register cleanup — do it here
// so each test starts with a fresh DOM.
afterEach(() => cleanup());

// jsdom lacks matchMedia. Report "reduced motion ON" so animation-driven
// components (Counter, Rotator, Reveal) take their deterministic, no-rAF path.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// jsdom lacks IntersectionObserver — stub a no-op.
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
