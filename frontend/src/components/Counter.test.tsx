import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Counter from "./Counter";

describe("Counter", () => {
  it("shows the target value (reduced-motion path)", () => {
    render(<Counter target={60} />);
    expect(screen.getByText("60")).toBeInTheDocument();
  });
});
