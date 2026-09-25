import jwt from "jsonwebtoken";

const BLACKLIST = new Set();
const BLACKLIST_CLEANUP_INTERVAL = 1000 * 60 * 60; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const item of BLACKLIST) {
    try {
      const decoded = jwt.decode(item);
      if (decoded && decoded.exp * 1000 < now) {
        BLACKLIST.delete(item);
      }
    } catch {
      BLACKLIST.delete(item);
    }
  }
}, BLACKLIST_CLEANUP_INTERVAL);

export const signAccessToken = (payload, options) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: options?.expiresIn || "7d" });
export const signRefreshToken = (payload, options) => jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: options?.expiresIn || "30d" });
export const signLoginAccessToken = (payload, options) => jwt.sign({ ...payload, purpose: "DEMO_LOGIN" }, process.env.JWT_SECRET, { expiresIn: options?.expiresIn || "30d" });

export const verifyAccessToken = (token) => {
  if (BLACKLIST.has(token)) throw new Error("Token revoked");
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.purpose === "DEMO_LOGIN") throw new Error("Invalid token type");
  return decoded;
};

export const verifyRefreshToken = (token) => {
  if (BLACKLIST.has(token)) throw new Error("Token revoked");
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};

export const verifyLoginAccessToken = (token) => {
  if (BLACKLIST.has(token)) throw new Error("Token revoked");
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.purpose !== "DEMO_LOGIN") throw new Error("Invalid token type");
  return decoded;
};

export const revokeToken = (token) => {
  if (token) BLACKLIST.add(token);
};
