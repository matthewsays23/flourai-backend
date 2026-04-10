const crypto = require("crypto");

function base64URLEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64URLEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
}

function createState() {
  return base64URLEncode(crypto.randomBytes(16));
}

module.exports = {
  createCodeVerifier,
  createCodeChallenge,
  createState,
};