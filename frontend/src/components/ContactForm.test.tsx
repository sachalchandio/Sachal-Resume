import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContactForm from "./ContactForm";

afterEach(() => vi.unstubAllGlobals());

describe("ContactForm", () => {
  it("posts the message and shows the success status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true, message: "Thanks — talk soon." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ContactForm />);
    await user.type(screen.getByLabelText("Name"), "Recruiter");
    await user.type(screen.getByLabelText("Email"), "r@co.com");
    await user.type(screen.getByLabelText("Message"), "We have a backend role for you.");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/Thanks/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contact",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("surfaces field errors from a 400 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({ ok: false, errors: { email: "A reachable email helps me reply." } }),
      })
    );
    const user = userEvent.setup();

    render(<ContactForm />);
    await user.type(screen.getByLabelText("Name"), "Bob");
    await user.type(screen.getByLabelText("Email"), "bad");
    await user.type(screen.getByLabelText("Message"), "this is long enough");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/reachable email/)).toBeInTheDocument();
  });
});
