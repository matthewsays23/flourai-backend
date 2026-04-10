const crypto = require("crypto");

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64UrlEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
}

function createState() {
  return base64UrlEncode(crypto.randomBytes(24));
}

module.exports = {
  createCodeVerifier,
  createCodeChallenge,
  createState,
};