// Every per-call action the server answers. A new action must be listed here, or its route 404s
// (red team 10/31: the owner's Send button had a handler but no route).
export const CALL_ROUTE =
  /^\/api\/calls\/([a-f0-9]{32})(?:\/(frame|speech|listen|mobile|say|text|tap|staged|tour|decision|confirmation|still|annotated|booking\.ics|frames\/\d{1,6}))?$/;
