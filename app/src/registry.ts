import type { EventHandler } from "./handler-types";
import { prdHandler } from "./prd-handler";

export type HandlerRegistry = Map<string, EventHandler>;

export function defaultRegistry(): HandlerRegistry {
  return new Map<string, EventHandler>([["prd", prdHandler]]);
}
