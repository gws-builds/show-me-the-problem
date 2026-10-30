// Spanish calls. The caller's language is detected in code from their words (sticky once clearly
// Spanish); the model is told to write its own lines in Spanish, and every line CODE composes
// (greeting, hazard lines, quotes, booking, shut-off steps, camera guidance, plate reading) is
// translated here from a fixed table. Lines the model already wrote in Spanish pass through.
// Muse Voice Transcribe already hears Spanish, and the hazard gate reads it (verifier.js).

const ES_WORDS = /\b(el|la|los|las|mi|mis|tengo|tiene|gotea|goteando|grifo|llave|agua|cocina|ba[ñn]o|por favor|cu[aá]nto|cuesta|hola|puede|puedes|est[aá]|debajo|fuga|calentador|caliente|fr[ií]a|no funciona|se sale|hace|ruido|luz|enchufe|aire|desde|abajo|arriba|qu[eé]|c[oó]mo|cu[aá]ndo|usted|necesito|quiero|vengan|venir|gracias|s[ií])\b/gi;
const EN_WORDS = /\b(the|my|is|it|and|from|under|when|what|how|can|you|please|drips?|leaks?|water|heater|price|cost|come|need|want|thanks|yes|no)\b/gi;

/** 'es' when the text is clearly Spanish, 'en' when clearly English, null when unsure (keep the current). */
export function detectLang(text) {
  const t = String(text ?? '').toLowerCase();
  const es = (t.match(ES_WORDS) ?? []).length; const en = (t.match(EN_WORDS) ?? []).length;
  if (es >= 2 && es > en) return 'es';
  if (en >= 3 && en > es * 2) return 'en';
  return null;
}

// Exact code lines -> Spanish (Latin American, "usted").
const EXACT = new Map([
  ['Hi, this is the office. Point your camera at the problem and tell me what is going on.', 'Hola, le habla la oficina. Apunte la cámara al problema y cuénteme qué pasa.'],
  ['The owner has been paged and is calling you. If you smell gas or see smoke or fire, leave the house now and call 911.', 'Ya avisamos al dueño y le va a llamar. Si huele a gas o ve humo o fuego, salga de la casa ahora y llame al 911.'],
  ['I am getting the owner on this right now. If you smell gas or see smoke or fire, leave the house and call 911.', 'Estoy avisando al dueño ahora mismo. Si huele a gas o ve humo o fuego, salga de la casa y llame al 911.'],
  ['Possible hazard: the owner is being called now. No price is given.', 'Posible peligro: estamos llamando al dueño ahora. No le damos precio.'],
  ['This visit is already settled. The office will text you.', 'Esta visita ya está resuelta. La oficina le enviará un mensaje.'],
  ['Let me get the owner to call you back to finish this.', 'Le pido al dueño que le devuelva la llamada para terminar.'],
  ['Let me get the owner to call you back.', 'Le pido al dueño que le devuelva la llamada.'],
  ['I still cannot see it. Could you tap it on your screen, or describe what you see?', 'Todavía no lo veo. ¿Puede tocarlo en la pantalla, o describir lo que ve?'],
  ['I did not catch that. Could you say it again?', 'No le entendí. ¿Me lo repite?'],
  ['The office could not take that slot. They will text you another time.', 'La oficina no pudo tomar ese horario. Le enviarán otro por mensaje.'],
  ['We could not see the part clearly. Please send a closer photo.', 'No pudimos ver bien la pieza. Acerque un poco más la cámara, por favor.'],
  ['The technician confirms the price on site.', 'El técnico confirma el precio en el lugar.'],
  ['Can you open the camera link I texted you?', '¿Puede abrir el enlace de la cámara que le envié?'],
  ['The owner is calling you about this now. No visit is booked until they do.', 'El dueño le está llamando por esto. No se agenda ninguna visita hasta que hable con usted.'],
  ['I can only guide water valves. For anything gas, do not touch the valve: if you smell gas, leave the house and call the gas company or 911.', 'Solo puedo guiarle con llaves de agua. Con el gas no toque la llave: si huele a gas, salga de la casa y llame a la compañía de gas o al 911.'],
  ['Would you like a price for a visit to look at any of this?', '¿Quiere un precio por una visita para revisar algo de esto?'],
  ['I have to stop the tour here. The owner will call you back.', 'Tengo que parar el recorrido aquí. El dueño le devolverá la llamada.'],
  ["I can't read the label from here. Move closer to the sticker on the side of the unit and hold still.", 'No alcanzo a leer la etiqueta. Acérquese a la etiqueta del costado del equipo y quédese quieto.'],
  ['Step back so I can see the whole panel. Please do not open the cover or touch anything inside.', 'Retroceda un paso para ver todo el panel. Por favor, no abra la tapa ni toque nada adentro.'],
  // Camera guidance (guidance.js)
  ["It is too dark for me to see. Turn on a light, or shine a second phone's flashlight on it.", 'Está muy oscuro para ver. Prenda una luz, o alumbre con la linterna de otro teléfono.'],
  ['Point the camera at it, slowly.', 'Apunte la cámara hacia ahí, despacio.'],
  ['Tilt up a little.', 'Incline un poco hacia arriba.'],
  ['Tilt down a little.', 'Incline un poco hacia abajo.'],
  ['Move a little to the left.', 'Muévase un poco a la izquierda.'],
  ['Move a little to the right.', 'Muévase un poco a la derecha.'],
  ['Move closer.', 'Acérquese.'],
  ['Back up a little.', 'Aléjese un poco.'],
  ['Hold still.', 'Quédese quieto.'],
  ['Got it. Hold still.', 'Listo. Quédese quieto.'],
]);

const MONTHS_ES = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio', July: 'julio', August: 'agosto', September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre' };
const EQUIP_ES = { 'water heater': 'calentador de agua', furnace: 'calefactor', boiler: 'caldera', 'air conditioner': 'aire acondicionado', 'heat pump': 'bomba de calor', unit: 'equipo' };
const equipEs = (s) => Object.entries(EQUIP_ES).reduce((t, [en, es]) => t.replace(new RegExp(`\\b${en}\\b`), es), s);
const monthEs = (s) => s.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, (m) => MONTHS_ES[m]);

// Code lines with values in them.
const PATTERNS = [
  [/^I can't see the (.{1,60}?) yet\. ?/, () => 'Todavía no lo veo. '],
  [/^For (.+?) the price is (\$[\d,.]+)\. The technician confirms on site\.(?: Your (.+?) is about (\d+) years old by its label, and the technician will bring the model details\.)?$/,
    (m, label, price, eq, age, ctx) => `Para ${ctx.labelEs?.(label) ?? label} el precio es ${price}. El técnico lo confirma en el lugar.${eq ? ` Según la etiqueta, su ${EQUIP_ES[eq] ?? eq} tiene unos ${age} años, y el técnico traerá los datos del modelo.` : ''}`],
  [/^I have asked the owner to confirm (.+?)\. You will get a text when it is booked\.$/, (m, slot) => `Le pedí al dueño que confirme ${slot}. Le llegará un mensaje cuando quede agendado.`],
  [/^You're booked for (.+?)\. The technician will bring what's in the brief\.$/, (m, slot) => `Quedó agendado para ${slot}. El técnico traerá lo indicado.`],
  [/^Got the label: a (.+?), made around (.+?)( going by the serial number)?, so about (\d+) years old\. I've added the model and serial for the technician\.$/,
    (m, who, when, serial, age) => `Ya leí la etiqueta: ${equipEs(who)}, fabricado alrededor de ${monthEs(when)}${serial ? ' según el número de serie' : ''}, o sea unos ${age} años. Agregué el modelo y la serie para el técnico.`],
  [/^Got the label: a (.+?)\. I've added it for the technician\.$/, (m, who) => `Ya leí la etiqueta: ${equipEs(who)}. La agregué para el técnico.`],
];

/** Translates a code-composed line for a Spanish call. Unknown lines (already Spanish from the model) pass through. */
export function toLang(text, lang, ctx = {}) {
  const t = String(text ?? '');
  if (lang !== 'es' || !t) return t;
  if (EXACT.has(t)) return EXACT.get(t);
  let out = t;
  for (const [re, fn] of PATTERNS) { const m = out.match(re); if (m) out = out.replace(re, (...a) => fn(...a.slice(0, m.length), ctx)); }
  // Water shut-off steps and other fixed sentences inside a longer line.
  for (const [en, es] of EXACT) if (en.length > 25 && out.includes(en)) out = out.replace(en, es);
  for (const [en, es] of SHUTOFF_ES) if (out.includes(en)) out = out.replace(en, es);
  return out;
}

// The fixed water shut-off playbook (evidence.js), sentence by sentence.
export const SHUTOFF_ES = new Map([
  ['Open the cabinet under the sink and clear a little space.', 'Abra el mueble debajo del fregadero y haga un poco de espacio.'],
  ['Find the two small valves on the pipes coming out of the wall or floor: usually hot on the left, cold on the right.', 'Busque las dos llavecitas en los tubos que salen de la pared o del piso: normalmente la caliente a la izquierda y la fría a la derecha.'],
  ['Turn each handle clockwise, to the right, until it stops. Oval handles turn a quarter turn. Do not force it.', 'Gire cada manija en el sentido del reloj, a la derecha, hasta que se detenga. Las manijas ovaladas giran un cuarto de vuelta. No la fuerce.'],
  ['Open the faucet to check: the water should slow to a stop. If a valve will not turn or starts to leak, stop and tell me.', 'Abra el grifo para revisar: el agua debe dejar de salir. Si una llave no gira o empieza a gotear, pare y avíseme.'],
  ['Look behind the toilet, near the floor or wall, for one small valve on the supply line.', 'Busque detrás del inodoro, cerca del piso o la pared, una llavecita en la manguera de agua.'],
  ['Turn it clockwise, to the right, until it stops. Do not force it.', 'Gírela en el sentido del reloj, a la derecha, hasta que se detenga. No la fuerce.'],
  ['Flush once: the tank should not refill. If the valve leaks or will not turn, stop and tell me.', 'Jale la cadena una vez: el tanque no debe volver a llenarse. Si la llave gotea o no gira, pare y avíseme.'],
  ['The main water shut-off is usually where the water line enters the house: basement wall, utility room, or near the water heater.', 'La llave principal de agua suele estar donde entra el tubo a la casa: en la pared del sótano, el cuarto de servicio o cerca del calentador.'],
  ['A lever handle turns a quarter turn so it sits across the pipe. A round wheel turns clockwise until it stops.', 'Una manija de palanca gira un cuarto de vuelta hasta quedar atravesada al tubo. Una rueda redonda gira en el sentido del reloj hasta que se detenga.'],
  ['If it is stuck, do not use tools on it. Tell me and the technician will handle it.', 'Si está trabada, no use herramientas. Avíseme y el técnico se encarga.'],
  ['I will outline the valves when I see them.', 'Marcaré las llaves en pantalla cuando las vea.'],
]);

/** Every exact English line we translate (tests check each has a Spanish version). */
export const TRANSLATED_LINES = [...EXACT.keys()];
