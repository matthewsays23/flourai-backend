const express = require("express");
const axios = require("axios");
const {
  createCodeVerifier,
  createCodeChallenge,
  createState,
} = require("../utils/pkce");

const router = express.Router();

router.get("/roblox/start", async (req, res) => {
  try {
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const state = createState();

    req.session.oauth_state = state;
    req.session.code_verifier = codeVerifier;

    const params = new URLSearchParams({
      client_id: process.env.ROBLOX_CLIENT_ID,
      redirect_uri: process.env.ROBLOX_REDIRECT_URI,
      response_type: "code",
      scope: "openid profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `https://apis.roblox.com/oauth/v1/authorize?${params.toString()}`;
    return res.redirect(authUrl);
  } catch (error) {
    console.error("Roblox start auth error:", error.message);
    return res.status(500).send("Failed to start Roblox login.");
  }
});

router.get("/roblox/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Missing code or state.");
    }

    if (state !== req.session.oauth_state) {
      return res.status(400).send("Invalid OAuth state.");
    }

    const tokenResponse = await axios.post(
      "https://apis.roblox.com/oauth/v1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ROBLOX_CLIENT_ID,
        client_secret: process.env.ROBLOX_CLIENT_SECRET,
        code,
        redirect_uri: process.env.ROBLOX_REDIRECT_URI,
        code_verifier: req.session.code_verifier,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const tokens = tokenResponse.data;

    const userResponse = await axios.get(
      "https://apis.roblox.com/oauth/v1/userinfo",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );

    const robloxUser = userResponse.data;

    req.session.user = {
      robloxId: robloxUser.sub,
      username: robloxUser.preferred_username || robloxUser.name || "Roblox User",
      displayName: robloxUser.name || robloxUser.preferred_username || "Roblox User",
    };

    return res.redirect(`${process.env.FRONTEND_URL}/auth/success`);
  } catch (error) {
    console.error(
      "Roblox callback error:",
      error.response?.data || error.message
    );
    return res.status(500).send("Roblox login failed.");
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    return res.json({ ok: true });
  });
});

module.exports = router;