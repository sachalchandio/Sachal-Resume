import { describe, it, expect, vi, afterEach } from "vitest";
import { getPortfolio, sendContact } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("getPortfolio fetches the endpoint and returns parsed JSON", async () => {
    const payload = { profile: { name: "Sachal" } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getPortfolio();
    expect(res).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/portfolio", expect.anything());
  });

  it("getPortfolio throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(getPortfolio()).rejects.toThrow();
  });

  it("sendContact posts JSON and returns status + data", async () => {
    const body = { ok: true, message: "ok" };
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const { status, data } = await sendContact({ name: "a", email: "b@c.com", message: "hello there" });
    expect(status).toBe(200);
    expect(data).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contact",
      expect.objectContaining({ method: "POST" })
    );
  });
});
