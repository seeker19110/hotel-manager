// Next replaces this one public build flag. Never import server/edge config or read the process environment object here.
export const IS_PRODUCTION_BUILD = process.env.NODE_ENV === "production";
