/**
 * Canonical Location value: WGS84 coordinates are optional and never inferred
 * from a display name. Geocoding belongs to an explicit external write path.
 */
export type LocationCoordinates = { latitude: number; longitude: number };
export type LocationValue = {
  name: string;
  address?: string;
  coordinates?: LocationCoordinates;
};

const NAME_MAX_LENGTH = 500;
const ADDRESS_MAX_LENGTH = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseLocationValue(raw: unknown): LocationValue | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !["name", "address", "coordinates"].includes(key))) {
    return null;
  }
  if (typeof raw.name !== "string") return null;
  const name = raw.name.trim();
  if (!name || name.length > NAME_MAX_LENGTH) return null;
  let address: string | undefined;
  if (raw.address !== undefined) {
    if (typeof raw.address !== "string") return null;
    address = raw.address.trim();
    if (!address || address.length > ADDRESS_MAX_LENGTH) return null;
  }
  let coordinates: LocationCoordinates | undefined;
  if (raw.coordinates !== undefined) {
    if (!isObject(raw.coordinates)
      || Object.keys(raw.coordinates).length !== 2
      || !Object.hasOwn(raw.coordinates, "latitude")
      || !Object.hasOwn(raw.coordinates, "longitude")) return null;
    const { latitude, longitude } = raw.coordinates;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return null;
    }
    coordinates = { latitude, longitude };
  }
  return {
    name,
    ...(address === undefined ? {} : { address }),
    ...(coordinates === undefined ? {} : { coordinates }),
  };
}

export function locationValueSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: NAME_MAX_LENGTH },
      address: { type: "string", minLength: 1, maxLength: ADDRESS_MAX_LENGTH },
      coordinates: {
        type: "object",
        additionalProperties: false,
        required: ["latitude", "longitude"],
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
        },
        "x-lifespace-crs": "WGS84",
      },
    },
    "x-lifespace-type": "location",
  };
}
