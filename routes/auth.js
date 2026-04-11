const express = require("express");
const axios = require("axios");
const {
  createCodeVerifier,
  createCodeChallenge,
  createState,
} = require("../utils/pkce");

const router = express.Router();

const isProduction = process.env.NODE_ENV === "production";

router.get("/roblox/start", async (req, res) => {
  try {
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("Session regenerate error:", regenErr);
        return res.status(500).send("Failed to start Roblox login.");
      }

      const codeVerifier = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);
      const state = createState();

      req.session.oauth_state = state;
      req.session.code_verifier = codeVerifier;

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("Failed to save auth session:", saveErr);
          return res.status(500).send("Failed to start Roblox login.");
        }

        console.log("OAuth start session saved:", {
          sessionID: req.sessionID,
          state,
        });

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
      });
    });
  } catch (error) {
    console.error("Roblox start auth error:", error.response?.data || error.message);
    return res.status(500).send("Failed to start Roblox login.");
  }
});

router.get("/roblox/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    console.log("OAuth callback hit:", {
      codeExists: !!code,
      stateFromQuery: state,
      sessionID: req.sessionID,
      sessionState: req.session?.oauth_state,
      hasVerifier: !!req.session?.code_verifier,
    });

    if (!code || !state) {
      return res.status(400).send("Missing code or state.");
    }

    if (!req.session) {
      return res.status(400).send("Session missing.");
    }

    if (!req.session.oauth_state || !req.session.code_verifier) {
      return res.status(400).send("OAuth session expired or missing.");
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
      username:
        robloxUser.preferred_username ||
        robloxUser.name ||
        "Roblox User",
      displayName:
        robloxUser.name ||
        robloxUser.preferred_username ||
        "Roblox User",
    };

    delete req.session.oauth_state;
    delete req.session.code_verifier;

    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).send("Failed to save login session.");
      }

      console.log("User logged in successfully:", req.session.user);

      return res.redirect(`${process.env.FRONTEND_URL}/auth/success`);
    });
  } catch (error) {
    console.error("Roblox callback error:", error.response?.data || error.message);
    return res.status(500).send("Roblox login failed.");
  }
});

router.get("/me", (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Not logged in" });
  }

  return res.json({
    ok: true,
    user: req.session.user,
  });
});

router.get("/avatar/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const response = await axios.get(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );

    const imageUrl = response.data?.data?.[0]?.imageUrl || "";

    return res.json({ ok: true, imageUrl });
  } catch (error) {
    console.error("Avatar fetch error:", error.response?.data || error.message);
    return res.status(500).json({ ok: false, error: "Failed to fetch avatar" });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to log out" });
    }

    res.clearCookie("flourai.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      domain: isProduction ? ".flourai.io" : undefined,
    });

    return res.json({ ok: true });
  });
});

module.exports = router;