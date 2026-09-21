export interface Station {
  id: string;
  name: string;
  /** minutes on foot from the location to the stop */
  walkMinutes: number;
  /** timetable anchor, "HH:MM" 24h */
  firstDeparture: string;
  /** headway in minutes */
  frequencyMinutes: number;
}

export interface TransitLocation {
  id: string;
  name: string;
  stations: Station[];
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

const STORAGE_KEY = "transit.locations.v1";
const SELECTION_KEY = "transit.selection.v1";

export function loadLocations(): TransitLocation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TransitLocation[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l) => l && typeof l.name === "string" && Array.isArray(l.stations));
  } catch {
    return [];
  }
}

export function saveLocations(locations: TransitLocation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
  } catch {
    // storage full / private mode — ignore, app still works in-memory
  }
}

export interface Selection {
  locationId: string | null;
  stationId: string | null;
}

export function loadSelection(): Selection {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return { locationId: null, stationId: null };
    const parsed = JSON.parse(raw) as Selection;
    return {
      locationId: typeof parsed.locationId === "string" ? parsed.locationId : null,
      stationId: typeof parsed.stationId === "string" ? parsed.stationId : null,
    };
  } catch {
    return { locationId: null, stationId: null };
  }
}

export function saveSelection(sel: Selection): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(sel));
  } catch {
    // ignore
  }
}

export function seedLocations(): TransitLocation[] {
  const homeId = uid();
  return [
    {
      id: homeId,
      name: "Home",
      stations: [
        {
          id: uid(),
          name: "Central stop",
          walkMinutes: 8,
          firstDeparture: "05:30",
          frequencyMinutes: 15,
        },
      ],
    },
  ];
}
