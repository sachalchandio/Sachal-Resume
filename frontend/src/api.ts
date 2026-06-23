import type { PortfolioData, OffDutyData, BuildingData, StatusData } from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Request to ${url} failed (${res.status})`);
  return (await res.json()) as T;
}

export const getPortfolio = () => getJSON<PortfolioData>("/api/portfolio");
export const getOffDuty = () => getJSON<OffDutyData>("/api/off-duty");
export const getProjects = () => getJSON<BuildingData>("/api/projects");
export const getStatus = () => getJSON<StatusData>("/api/status");

export interface ContactResult {
  ok: boolean;
  message?: string;
  errors?: Record<string, string>;
}

export async function sendContact(payload: {
  name: string;
  email: string;
  message: string;
}): Promise<{ status: number; data: ContactResult }> {
  const res = await fetch("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as ContactResult;
  return { status: res.status, data };
}
