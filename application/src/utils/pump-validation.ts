import { convertVolume, SUPPORTED_VOLUME_UNITS, type VolumeUnit } from './unit-conversion';

// Unzoned pumping input means UTC. Validate calendar fields before parsing so
// impossible dates cannot roll over or fall back to the current time.
export function parsePumpTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/);
  if (!match) return null;
  const [, date, hour = '00', minute = '00', second = '00', fraction = '', offset = 'Z'] = match;
  const wall = `${date}T${hour}:${minute}:${second}${fraction}`;
  const calendar = new Date(wall + 'Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== wall.slice(0, 19)) return null;
  const normalizedOffset = offset !== 'Z' && !offset.includes(':') ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset;
  const instant = new Date(wall + normalizedOffset);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

export const validPumpDuration = (value: unknown): value is number | null => value === null ||
  (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647);

// Inventory converts between OZ/ML and rounds with *100. Bound amounts by JS's
// safe hundredths precision, not an arbitrary physiological cap. Conversion
// may produce fractional hundredths; it need not be an integer.
export function representablePumpAmount(value: unknown, unit: VolumeUnit | null): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
    unit !== null && SUPPORTED_VOLUME_UNITS.every(target => {
      const hundredths = convertVolume(value, unit, target) * 100;
      return Number.isFinite(hundredths) && hundredths <= Number.MAX_SAFE_INTEGER;
    }));
}
