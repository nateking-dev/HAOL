import type { Context } from "hono";
import { ValidationError } from "./middleware/error-handler.js";

export async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ValidationError("Invalid JSON request body");
    }
    throw err;
  }
}
