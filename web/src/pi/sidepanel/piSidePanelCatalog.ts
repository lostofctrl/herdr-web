import type { PiCatalog, PiCatalogEntry } from "../piProtocol";

export function piCatalogTrigger(entry: PiCatalogEntry, kind: "command" | "skill"): string {
  if (entry.name.startsWith("/")) return entry.name;
  const prefix = kind === "skill" && !entry.name.startsWith("skill:") ? "/skill:" : "/";
  return `${prefix}${entry.name}`;
}

export function piSidePanelEntries(catalog: PiCatalog, skillsEnabled: boolean, query: string) {
  const entries = [
    ...catalog.commands.map((entry) => ({ ...entry, kind: "command" as const })),
    ...(skillsEnabled
      ? catalog.skills.map((entry) => ({ ...entry, kind: "skill" as const })) : []),
  ];
  const search = query.trim().toLowerCase();
  return entries.filter((entry) =>
    `${entry.name} ${entry.description} ${entry.source}`.toLowerCase().includes(search),
  );
}
