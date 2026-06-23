export interface Profile {
  name: string;
  role: string;
  focus: string;
  headline_lead: string;
  headline_rotate: string[];
  summary: string;
  location: string;
  availability: string;
  email: string;
  phone: string;
  links: { github: string; linkedin: string };
}

export interface Metric {
  value: number;
  prefix: string;
  suffix: string;
  label: string;
  note: string;
}

export interface Capability {
  icon: string;
  title: string;
  body: string;
  proof: string;
  tags: string[];
}

export interface About {
  paragraphs: string[];
  facts: { k: string; v: string }[];
}

export interface Project {
  id: string;
  name: string;
  org: string;
  tagline: string;
  problem: string;
  approach: string;
  impact: string[];
  stack: string[];
  accent: string;
}

export interface Experience {
  role: string;
  company: string;
  location: string;
  period: string;
  current: boolean;
  summary: string;
  stack: string[];
}

export type Stack = Record<string, string[]>;

export interface Education {
  degree: string;
  school: string;
}

export interface PortfolioData {
  profile: Profile;
  metrics: Metric[];
  capabilities: Capability[];
  about: About;
  projects: Project[];
  experience: Experience[];
  stack: Stack;
  education: Education[];
  youtube: string;
}

export interface Game {
  title: string;
  kind: string;
  note: string;
  accent: string;
}

export interface Anime {
  title: string;
  kicker: string;
  accent: string;
  quotes: string[];
}

export interface OffDutyData {
  gaming: Game[];
  anime: Anime[];
  berserk: string[];
  youtube: string;
  profile: { name: string };
}

export interface ProjectWIP {
  id: string;
  name: string;
  status: string;
  world: string;
  tagline: string;
  pitch: string;
  problem: string;
  does: { k: string; v: string }[];
  technical: { title: string; body: string };
  features: { icon: string; text: string }[];
  stack: Record<string, string[]>;
  methodology: { k: string; v: string }[];
  ambition: string;
  accent: string;
  accentGold: string;
}

export interface BuildingData {
  building: ProjectWIP[];
}

export interface StatusData {
  status: string;
  service: string;
  version: string;
  commit: string | null;
  region: string;
  runtime: string;
  started_at: string;
  uptime_seconds: number;
  requests_served: number;
  latency_ms: { last: number | null; p50: number | null; p95: number | null };
  samples: number[];
  now: string;
}
