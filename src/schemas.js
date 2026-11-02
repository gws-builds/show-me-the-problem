// Structured outputs for every JSON call to Muse Spark and Muse Wonder (red team #5, M1): the API
// returns JSON that matches these shapes (text.format json_schema, strict; checked on api.meta.ai
// 2026-11-01), so code no longer fishes JSON out of free text. firstJson stays only as a fallback.
// Strict mode needs every property listed in `required` and no extra properties.
import { ROOMS } from './kb.js';

const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: 'string' };
const num = { type: 'number' };
const numOrNull = { type: ['number', 'null'] };
const oneOf = (...values) => ({ type: 'string', enum: values });
const list = (items) => ({ type: 'array', items });

export const SCHEMAS = {
  scan: obj({
    findings: list(
      obj({
        category: oneOf('flammables', 'water_electric', 'wiring', 'scorch'),
        object: str,
        near: str,
        why: str,
        where: oneOf('panel', 'wall_box', 'fixture', 'appliance', 'cord', 'other'),
        powered: oneOf('yes', 'no', 'unknown'),
      }),
    ),
  }),
  inspect: obj({
    visible: { type: 'boolean' },
    observation: str,
    faucet_type: oneOf('single-handle cartridge', 'two-handle compression', 'ball', 'unknown', 'n/a'),
    confidence: num,
  }),
  plate: obj({
    visible: { type: 'boolean' },
    equipment: oneOf('water heater', 'furnace', 'boiler', 'air conditioner', 'heat pump', 'other'),
    brand: str,
    model: str,
    serial: str,
    mfg_date_printed: str,
    fuel: oneOf('natural gas', 'propane', 'electric', 'oil', 'unknown'),
    capacity_gal: numOrNull,
    input_btu: numOrNull,
    kw: numOrNull,
    volts: numOrNull,
    refrigerant: str,
    legible: num,
  }),
  tour: obj({
    room: oneOf(...ROOMS),
    items: list(
      obj({
        part: str,
        status: oneOf('normal', 'attention', 'safety', 'cant_tell'),
        evidence: str,
        hazard: str,
        better_view: str,
        x: num,
        y: num,
      }),
    ),
    move: oneOf('pan_left', 'pan_right', 'step_back', 'closer', 'tilt_up', 'tilt_down', 'hold'),
  }),
  review: obj({ steps: list(obj({ step: str, cites: list(str) })), gaps: list(str) }),
  ground: obj({ points: list(obj({ object_name: str, x: num, y: num, box: list(num) })) }),
};

/** The Responses API `text` parameter for one schema. */
export const jsonFormat = (name) => ({ format: { type: 'json_schema', name, strict: true, schema: SCHEMAS[name] } });
