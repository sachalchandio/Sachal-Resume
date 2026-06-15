import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Rotator from "./Rotator";

describe("Rotator", () => {
  it("renders the first word", () => {
    render(<Rotator words={["fast", "consistent", "observable"]} />);
    expect(screen.getByText("fast")).toBeInTheDocument();
  });
});
